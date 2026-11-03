/**
 * `canary critical-areas` (#1529) end to end against real repositories: the
 * write path, the abstain-and-write-nothing path, and the determinism katana
 * and the engine readers rely on.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function git(
  cwd: string,
  args: string[],
  date = '2020-06-01T00:00:00Z',
): string {
  // GIT_DIR-style variables inside a pre-commit hook would point git at this
  // repository instead of the fixture.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf-8',
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

function commit(
  root: string,
  files: Record<string, string>,
  date?: string,
): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, 'utf-8');
  }
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-m', 'c', '--allow-empty'], date);
}

interface AreaRow {
  path: string;
  risk_score: number;
  churn_commits: number | null;
  importers: number;
  coverage_pct: number | null;
  signals: string[];
  symbols?: string[];
}

interface Doc {
  generated: string;
  base: string;
  generator: string;
  files_analyzed: number;
  signal_sources: Record<
    string,
    {
      status: string;
      reason?: string;
      report?: string;
      files_matched?: number;
    }
  >;
  areas: AreaRow[];
}

const OUT = join('.canary', 'critical-areas.json');

const readDoc = (path: string): Doc =>
  JSON.parse(readFileSync(path, 'utf-8')) as Doc;

const areaOf = (doc: Doc, path: string): AreaRow => {
  const found = doc.areas.find((a) => a.path === path);
  if (found === undefined) throw new Error(`${path} is not listed`);
  return found;
};

/** `src/a.ts` imports `src/b.ts`; a second commit touches `src/a.ts`. */
function ranked(root: string): void {
  git(root, ['init', '-q']);
  commit(root, {
    'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  });
  commit(root, {
    'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
  });
}

/** A depth-1 clone of `source`, placed beside it under `root`. */
function shallowClone(root: string, source: string): string {
  const clone = join(root, 'clone');
  git(root, ['clone', '-q', '--depth', '1', `file://${source}`, clone]);
  return clone;
}

describe('canary critical-areas', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  describe('writing', () => {
    it('writes the default file with HEAD, churn and importers (criterion 1)', async () => {
      ranked(root);
      const res = await invokeCanary(['critical-areas', '--root', root]);
      expect(res.code).toBe(0);
      const doc = readDoc(join(root, OUT));
      expect(doc.generator).toBe('canary critical-areas');
      expect(doc.base).toBe(git(root, ['rev-parse', 'HEAD']).trim());
      expect(doc.files_analyzed).toBe(2);
      expect(areaOf(doc, 'src/b.ts').importers).toBe(1);
      expect(areaOf(doc, 'src/a.ts').churn_commits).toBe(2);
      expect(res.stdout).toContain('Wrote ');
    });

    it('writes to --out, creating parents and leaving .canary/ absent (criterion 2)', async () => {
      ranked(root);
      const out = join(root, 'nested', 'deep', 'x.json');
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        '--out',
        out,
      ]);
      expect(res.code).toBe(0);
      expect(readDoc(out).areas.length).toBeGreaterThan(0);
      expect(existsSync(join(root, '.canary'))).toBe(false);
    });

    it('anchors a subdirectory --root to the repository top (D16)', async () => {
      ranked(root);
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        join(root, 'src'),
      ]);
      expect(res.code).toBe(0);
      const doc = readDoc(join(realpathSync(root), OUT));
      expect(doc.areas.map((a) => a.path).sort()).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
      expect(existsSync(join(root, 'src', '.canary'))).toBe(false);
    });

    it('writes documents differing only in generated (criterion 10)', async () => {
      ranked(root);
      await invokeCanary(['critical-areas', '--root', root]);
      const first = readDoc(join(root, OUT));
      await invokeCanary(['critical-areas', '--root', root]);
      const second = readDoc(join(root, OUT));
      expect(Number.isNaN(Date.parse(first.generated))).toBe(false);
      expect({ ...first, generated: '' }).toEqual({
        ...second,
        generated: '',
      });
      expect(first.areas.length).toBeGreaterThan(0);
    });
  });

  describe('abstaining (criterion 7)', () => {
    async function expectAbstain(at: string): Promise<void> {
      const res = await invokeCanary(['critical-areas', '--root', at]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout + res.stderr).toContain('Abstained');
      expect(existsSync(join(at, OUT))).toBe(false);
    }

    /** Two sources importing nothing; shallow, so every score is 0. */
    function allZero(): string {
      const source = join(root, 'source');
      mkdirSync(source);
      git(source, ['init', '-q']);
      commit(source, {
        'src/a.ts': 'export {};\n',
        'src/b.ts': 'export {};\n',
      });
      return shallowClone(root, source);
    }

    it('outside a git repository', async () => {
      await expectAbstain(root);
    });

    it('in a repository with no commit', async () => {
      git(root, ['init', '-q']);
      await expectAbstain(root);
    });

    it('with no source file in HEAD', async () => {
      git(root, ['init', '-q']);
      commit(root, { 'README.md': '# x\n' });
      await expectAbstain(root);
    });

    it('when every score is 0', async () => {
      await expectAbstain(allZero());
    });

    it('leaves an existing output file byte-identical', async () => {
      const clone = allZero();
      const out = join(clone, OUT);
      mkdirSync(dirname(out), { recursive: true });
      const planted = '{ "planted":   true }\n';
      writeFileSync(out, planted, 'utf-8');
      const res = await invokeCanary(['critical-areas', '--root', clone]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(readFileSync(out, 'utf-8')).toBe(planted);
    });
  });

  describe('coverage', () => {
    const LCOV_A = 'SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n';
    const put = (name: string, body: string): void => {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), body, 'utf-8');
    };
    const run = async (...extra: string[]): Promise<Doc> => {
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        ...extra,
      ]);
      expect(res.code).toBe(0);
      return readDoc(join(root, OUT));
    };

    it('writes null and names the looked-for reports with none present (criterion 3)', async () => {
      ranked(root);
      const doc = await run();
      expect(doc.areas.length).toBeGreaterThan(0);
      for (const a of doc.areas) expect(a.coverage_pct).toBeNull();
      expect(doc.signal_sources.coverage!.status).toBe('absent');
      expect(doc.signal_sources.coverage!.reason).toContain(
        'coverage/lcov.info',
      );
    });

    it('reads a discovered report, leaving an unlisted file null (criterion 4)', async () => {
      ranked(root);
      put('coverage/lcov.info', LCOV_A);
      const doc = await run();
      expect(areaOf(doc, 'src/a.ts').coverage_pct).toBe(50);
      expect(areaOf(doc, 'src/b.ts').coverage_pct).toBeNull();
      expect(doc.signal_sources.coverage).toEqual({
        status: 'measured',
        report: 'coverage/lcov.info',
        files_matched: 1,
      });
    });

    it('keeps a measured 0 as 0', async () => {
      ranked(root);
      put('coverage/lcov.info', 'SF:src/a.ts\nDA:1,0\nend_of_record\n');
      const a = areaOf(await run(), 'src/a.ts');
      expect(a.coverage_pct).toBe(0);
      expect(a.signals).toContain('low_coverage');
    });

    it('prefers coverage/lcov.info over lcov.info (D11)', async () => {
      ranked(root);
      put('coverage/lcov.info', LCOV_A);
      put('lcov.info', 'SF:src/a.ts\nDA:1,1\nend_of_record\n');
      const doc = await run();
      expect(doc.signal_sources.coverage!.report).toBe('coverage/lcov.info');
      expect(areaOf(doc, 'src/a.ts').coverage_pct).toBe(50);
    });

    it('reads an explicit --coverage report', async () => {
      ranked(root);
      put('reports/my.lcov.info', LCOV_A);
      const doc = await run(
        '--coverage',
        join(root, 'reports', 'my.lcov.info'),
      );
      expect(areaOf(doc, 'src/a.ts').coverage_pct).toBe(50);
      expect(doc.signal_sources.coverage!.report).toBe('reports/my.lcov.info');
    });

    it('exits 2 on a missing explicit report and writes nothing (D12)', async () => {
      ranked(root);
      const missing = join(root, 'missing.info');
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        '--coverage',
        missing,
      ]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain(missing);
      expect(existsSync(join(root, OUT))).toBe(false);
    });

    it('exits 2 on an unparseable explicit report and writes nothing (D12)', async () => {
      ranked(root);
      put('bad.json', 'not json');
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        '--coverage',
        join(root, 'bad.json'),
      ]);
      expect(res.code).toBe(2);
      expect(existsSync(join(root, OUT))).toBe(false);
    });

    it('checks the explicit report before the repository', async () => {
      put('bad.json', 'not json');
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        '--coverage',
        join(root, 'bad.json'),
      ]);
      expect(res.code).toBe(2);
    });

    it('degrades on a discovered unparseable report (D12)', async () => {
      ranked(root);
      put('coverage/coverage.json', 'not json');
      const source = (await run()).signal_sources.coverage!;
      expect(source.status).toBe('absent');
      expect(source.reason).toMatch(/could not/);
    });

    it('degrades on a discovered report matching 0 files (D12)', async () => {
      ranked(root);
      put('coverage/lcov.info', 'SF:other/z.ts\nDA:1,1\nend_of_record\n');
      const source = (await run()).signal_sources.coverage!;
      expect(source.status).toBe('absent');
      expect(source.reason).toMatch(/0 of 2/);
    });

    it('degrades on an explicit report matching 0 files (D12)', async () => {
      ranked(root);
      put('r/z.info', 'SF:other/z.ts\nDA:1,1\nend_of_record\n');
      const source = (await run('--coverage', join(root, 'r', 'z.info')))
        .signal_sources.coverage!;
      expect(source.status).toBe('absent');
      expect(source.reason).toMatch(/0 of 2/);
    });
  });

  it('ranks a shallow clone on importers alone (criterion 8)', async () => {
    const source = join(root, 'source');
    mkdirSync(source);
    ranked(source);
    const clone = shallowClone(root, source);
    const res = await invokeCanary(['critical-areas', '--root', clone]);
    expect(res.code).toBe(0);
    const doc = readDoc(join(clone, OUT));
    expect(doc.signal_sources.churn!.status).toBe('absent');
    expect(doc.signal_sources.churn!.reason).toMatch(/shallow/);
    const b = areaOf(doc, 'src/b.ts');
    expect(b.churn_commits).toBeNull();
    expect(b.risk_score).toBe(1);
  });
});
