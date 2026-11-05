/**
 * `canary critical-areas` (#1529) end to end against real repositories: the
 * write path, the abstain-and-write-nothing path, and the determinism katana
 * and the engine readers rely on.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  importers: number | null;
  coverage_pct: number | null;
  signals: string[];
  recommended_test_types: string[];
  summary: string;
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
      files_read?: number;
      files_unread?: number;
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

  describe('binding a report to a file', () => {
    const unhit = (key: string): string => `SF:${key}\nDA:1,0\nend_of_record\n`;
    const repo = (files: Record<string, string>): void => {
      git(root, ['init', '-q']);
      commit(root, files);
    };
    const report = (name: string, body: string): void => {
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
    const ROOT_FILES = {
      'src/index.ts': 'export {};\n',
      'index.ts': 'export {};\n',
    };

    it.each([
      [
        'an absolute key outside the repository',
        '/ci/build/pkg-a/src/index.ts',
      ],
      ['a relative key in a directory that is gone', 'gone/src/index.ts'],
    ])('%s binds nothing by suffix', async (_name, key) => {
      repo(ROOT_FILES);
      report('coverage/lcov.info', unhit(key));
      const doc = await run();
      expect(areaOf(doc, 'src/index.ts').coverage_pct).toBeNull();
      expect(areaOf(doc, 'index.ts').coverage_pct).toBeNull();
      expect(doc.signal_sources.coverage!.status).toBe('absent');
    });

    it('a bare key binds neither of two same-named files', async () => {
      repo({ 'pkg-a/lib.ts': 'export {};\n', 'pkg-b/lib.ts': 'export {};\n' });
      report('coverage/lcov.info', unhit('lib.ts'));
      const doc = await run();
      expect(areaOf(doc, 'pkg-a/lib.ts').coverage_pct).toBeNull();
      expect(areaOf(doc, 'pkg-b/lib.ts').coverage_pct).toBeNull();
    });

    it('an absolute key under the top level binds that file only', async () => {
      repo(ROOT_FILES);
      report('coverage/lcov.info', unhit(`${realpathSync(root)}/src/index.ts`));
      const doc = await run();
      expect(areaOf(doc, 'src/index.ts').coverage_pct).toBe(0);
      expect(areaOf(doc, 'index.ts').coverage_pct).toBeNull();
      expect(doc.signal_sources.coverage!.files_matched).toBe(1);
    });

    it('a subpackage report still binds through its anchor', async () => {
      repo({ 'pkg/src/a.ts': 'export {};\n', 'src/other.ts': 'export {};\n' });
      report('pkg/coverage/lcov.info', unhit('src/a.ts'));
      const doc = await run(
        '--coverage',
        join(root, 'pkg', 'coverage', 'lcov.info'),
      );
      expect(areaOf(doc, 'pkg/src/a.ts').coverage_pct).toBe(0);
      expect(areaOf(doc, 'src/other.ts').coverage_pct).toBeNull();
    });
  });

  describe('a report without a denominator', () => {
    const json = (files: unknown): void => {
      mkdirSync(join(root, 'coverage'));
      writeFileSync(
        join(root, 'coverage', 'coverage.json'),
        JSON.stringify({ files }),
        'utf-8',
      );
    };
    const run = async (): Promise<Doc> => {
      const res = await invokeCanary(['critical-areas', '--root', root]);
      expect(res.code).toBe(0);
      return readDoc(join(root, OUT));
    };

    it('reads covered_lines alone as unknown, not 100%', async () => {
      ranked(root);
      json({ 'src/a.ts': { covered_lines: [1] } });
      const doc = await run();
      expect(areaOf(doc, 'src/a.ts').coverage_pct).toBeNull();
    });

    it('still reads a declared denominator', async () => {
      ranked(root);
      json({ 'src/a.ts': { covered_lines: [1], instrumented_lines: [1, 2] } });
      const doc = await run();
      expect(areaOf(doc, 'src/a.ts').coverage_pct).toBe(50);
      expect(doc.signal_sources.coverage!.status).toBe('measured');
    });

    it('does not call a coverage.py report measured', async () => {
      ranked(root);
      json({
        'src/a.ts': {
          executed_lines: [1],
          missing_lines: [2],
          summary: { percent_covered: 50 },
        },
      });
      const source = (await run()).signal_sources.coverage!;
      expect(source.status).toBe('absent');
      expect(source.reason).toContain('coverage/coverage.json');
      expect(source.reason).toMatch(/0 of 2/);
    });

    it('counts only files with a percentage in files_matched', async () => {
      ranked(root);
      json({
        'src/a.ts': { covered_lines: [1], instrumented_lines: [1, 2] },
        'src/b.ts': { covered_lines: [1] },
      });
      const source = (await run()).signal_sources.coverage!;
      expect(source.files_matched).toBe(1);
    });
  });

  describe('failing to write', () => {
    const run = (out: string) =>
      invokeCanary(['critical-areas', '--root', root, '--out', out]);
    const expectOneLine = (stderr: string, out: string, code: RegExp): void => {
      expect(stderr.trim().split('\n')).toHaveLength(1);
      expect(stderr).toContain(out);
      expect(stderr).toMatch(code);
    };

    it('exits 1 naming the path when --out is a directory, leaving no temp file', async () => {
      ranked(root);
      const out = join(root, 'adir');
      mkdirSync(out);
      const res = await run(out);
      expect(res.code).toBe(1);
      expectOneLine(res.stderr, out, /\bE[A-Z]+\b/);
      expect(readdirSync(root).filter((n) => n.includes('tmp'))).toEqual([]);
      expect(readdirSync(out)).toEqual([]);
    });

    it('exits 1 when a parent of --out is a file', async () => {
      ranked(root);
      writeFileSync(join(root, 'afile'), 'x', 'utf-8');
      const out = join(root, 'afile', 'x.json');
      const res = await run(out);
      expect(res.code).toBe(1);
      expectOneLine(res.stderr, out, /\b(?:ENOTDIR|EEXIST)\b/);
    });

    // Root ignores the mode bits, so there is nothing to prove there.
    it.skipIf(process.getuid?.() === 0)(
      'leaves an existing file intact in a read-only directory',
      async () => {
        ranked(root);
        const dir = join(root, 'locked');
        mkdirSync(dir);
        const out = join(dir, 'x.json');
        writeFileSync(out, 'planted', 'utf-8');
        chmodSync(dir, 0o555);
        try {
          const res = await run(out);
          expect(res.code).toBe(1);
          expectOneLine(res.stderr, out, /\bEACCES\b/);
          expect(readFileSync(out, 'utf-8')).toBe('planted');
          expect(readdirSync(dir)).toEqual(['x.json']);
        } finally {
          chmodSync(dir, 0o755);
        }
      },
    );

    it('leaves nothing beside the file on success', async () => {
      ranked(root);
      const dir = join(root, 'ok');
      const res = await run(join(dir, 'x.json'));
      expect(res.code).toBe(0);
      expect(readdirSync(dir)).toEqual(['x.json']);
    });
  });

  // A scanned checkout is untrusted: `git clone` materialises tracked symlinks,
  // so a command that reads a repository must not write through one of them.
  describe.skipIf(process.platform === 'win32')('planted symlinks', () => {
    const PRECIOUS = 'precious\n';
    // The name the write used to use, which any tree could plant ahead of time.
    const oldTempName = (name: string): string => `${name}.${process.pid}.tmp`;
    let repo: string;
    let victim: string;
    let elsewhere: string;

    /** The fixture repository, with its links committed as tracked files. */
    function trackedLinks(links: Record<string, string>): void {
      ranked(repo);
      for (const [path, target] of Object.entries(links)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        symlinkSync(target, join(repo, path));
      }
      commit(repo, {});
    }

    beforeEach(() => {
      repo = join(root, 'repo');
      mkdirSync(repo);
      victim = join(root, 'victim.txt');
      writeFileSync(victim, PRECIOUS, 'utf-8');
      elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
    });

    const expectRegularMap = (path: string): void => {
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readDoc(path).areas.length).toBeGreaterThan(0);
    };

    it('does not write through a tracked symlink at the old temp path', async () => {
      const planted = `.canary/${oldTempName('critical-areas.json')}`;
      trackedLinks({ [planted]: victim });

      const res = await invokeCanary(['critical-areas', '--root', repo]);

      expect(res.code).toBe(0);
      expect(readFileSync(victim, 'utf-8')).toBe(PRECIOUS);
      expectRegularMap(join(repo, '.canary', 'critical-areas.json'));
      expect(readlinkSync(join(repo, planted))).toBe(victim);
      expect(readdirSync(join(repo, '.canary')).sort()).toEqual(
        ['critical-areas.json', oldTempName('critical-areas.json')].sort(),
      );
    });

    it('does not write through a symlink beside --out', async () => {
      ranked(repo);
      const dir = join(root, 'out');
      mkdirSync(dir);
      const out = join(dir, 'areas.json');
      symlinkSync(victim, join(dir, oldTempName('areas.json')));

      const res = await invokeCanary([
        'critical-areas',
        '--root',
        repo,
        '--out',
        out,
      ]);

      expect(res.code).toBe(0);
      expect(readFileSync(victim, 'utf-8')).toBe(PRECIOUS);
      expectRegularMap(out);
    });

    describe('a default output whose .canary leaves the top level', () => {
      const expectRefused = async (): Promise<void> => {
        const res = await invokeCanary(['critical-areas', '--root', repo]);
        expect(res.code).toBe(1);
        const lines = res.stderr.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('.canary');
        expect(lines[0]).toContain('--out');
        expect(res.stdout).not.toContain('Wrote');
      };

      it('is refused through an absolute link, writing nothing', async () => {
        trackedLinks({ '.canary': elsewhere });
        await expectRefused();
        expect(readdirSync(elsewhere)).toEqual([]);
      });

      it('is refused through a relative link, writing nothing', async () => {
        trackedLinks({ '.canary': '../elsewhere' });
        await expectRefused();
        expect(readdirSync(elsewhere)).toEqual([]);
      });

      it('is refused through a chain of links, writing nothing', async () => {
        trackedLinks({ hop: '../elsewhere', '.canary': 'hop' });
        await expectRefused();
        expect(readdirSync(elsewhere)).toEqual([]);
      });

      it('leaves a map already there byte-identical', async () => {
        trackedLinks({ '.canary': elsewhere });
        const there = join(elsewhere, 'critical-areas.json');
        writeFileSync(there, PRECIOUS, 'utf-8');
        await expectRefused();
        expect(readFileSync(there, 'utf-8')).toBe(PRECIOUS);
        expect(readdirSync(elsewhere)).toEqual(['critical-areas.json']);
      });

      it('fails closed on a link it cannot resolve, creating nothing', async () => {
        trackedLinks({ '.canary': '../gone' });
        await expectRefused();
        expect(existsSync(join(root, 'gone'))).toBe(false);
      });

      it('fails closed on a link loop', async () => {
        trackedLinks({ '.canary': '.canary' });
        await expectRefused();
      });
    });

    it('still writes through a .canary link that stays inside the top level', async () => {
      trackedLinks({ '.canary': 'config/canary' });
      commit(repo, { 'config/canary/keep.txt': 'x' });

      const res = await invokeCanary(['critical-areas', '--root', repo]);

      expect(res.code).toBe(0);
      expectRegularMap(join(repo, 'config', 'canary', 'critical-areas.json'));
    });

    it('does not refuse an explicit --out for pointing elsewhere', async () => {
      trackedLinks({ '.canary': elsewhere });
      const out = join(elsewhere, 'areas.json');

      const res = await invokeCanary([
        'critical-areas',
        '--root',
        repo,
        '--out',
        out,
      ]);

      expect(res.code).toBe(0);
      expectRegularMap(out);
      expect(readdirSync(elsewhere)).toEqual(['areas.json']);
    });
  });

  describe('git', () => {
    it('lets --root decide the repository, not the hook environment', async () => {
      const decoy = join(root, 'decoy');
      const real = join(root, 'real');
      mkdirSync(decoy);
      mkdirSync(real);
      git(decoy, ['init', '-q']);
      commit(decoy, { 'decoy.ts': 'export {};\n' });
      ranked(real);
      const dotGit = join(decoy, '.git');
      const res = await invokeCanary(
        ['critical-areas', '--root', join(real, 'src')],
        {
          env: {
            GIT_DIR: dotGit,
            GIT_WORK_TREE: decoy,
            GIT_INDEX_FILE: join(dotGit, 'index'),
            GIT_OBJECT_DIRECTORY: join(dotGit, 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(dotGit, 'objects'),
            GIT_COMMON_DIR: dotGit,
            GIT_PREFIX: 'decoy/',
          },
        },
      );
      expect(res.code).toBe(0);
      const doc = readDoc(join(realpathSync(real), OUT));
      expect(areaOf(doc, 'src/b.ts').importers).toBe(1);
      expect(existsSync(join(real, 'src', '.canary'))).toBe(false);
    });

    it('says git was not found when it cannot be spawned', async () => {
      ranked(root);
      const res = await invokeCanary(['critical-areas', '--root', root], {
        env: { PATH: join(root, 'no-such-bin') },
      });
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('git was not found');
      expect(res.stdout).not.toContain('not in a git repository');
    });

    it('still blames the directory when only the directory is wrong', async () => {
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        join(root, 'no-such-dir'),
      ]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('not in a git repository');
    });

    it('records a failed git log as unmeasured churn, never 0', async () => {
      ranked(root);
      const parent = git(root, ['rev-parse', 'HEAD~1']).trim();
      rmSync(
        join(root, '.git', 'objects', parent.slice(0, 2), parent.slice(2)),
      );
      const res = await invokeCanary(['critical-areas', '--root', root]);
      expect(res.code).toBe(0);
      const doc = readDoc(join(root, OUT));
      const b = areaOf(doc, 'src/b.ts');
      expect(b.churn_commits).toBeNull();
      expect(b.risk_score).toBe(1);
      expect(doc.signal_sources.churn!.status).toBe('absent');
      expect(doc.signal_sources.churn!.reason).toMatch(/git log failed/);
    });
  });

  describe('declared symbols (D13)', () => {
    /** Plant an existing map holding `areas`, as a person or the skill would. */
    const plant = (areas: unknown[], at = join(root, OUT)): void => {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, JSON.stringify({ areas }), 'utf-8');
    };
    const run = () => invokeCanary(['critical-areas', '--root', root]);

    it('keeps symbols through a rewrite (criterion 9)', async () => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols: ['chargeCard'] }]);
      expect((await run()).code).toBe(0);
      const doc = readDoc(join(root, OUT));
      expect(areaOf(doc, 'src/a.ts').symbols).toEqual(['chargeCard']);
      expect(areaOf(doc, 'src/b.ts').symbols).toBeUndefined();
    });

    it('lists a signal-less declared path outside the top 25 (criterion 9)', async () => {
      git(root, ['init', '-q']);
      const tree: Record<string, string> = { 'src/quiet.ts': 'export {};\n' };
      const names = Array.from({ length: 26 }, (_, i) => `m${i}`);
      for (const name of names) {
        tree[`src/${name}.ts`] = 'export {};\n';
      }
      tree['src/entry.ts'] = names.map((n) => `import './${n}.js';\n`).join('');
      commit(root, tree);
      // A year later, so the first commit falls outside the churn window:
      // `src/quiet.ts` has neither churn nor importers, and 26 others score.
      const touched = Object.fromEntries(
        names.map((n) => [`src/${n}.ts`, 'export const x = 1;\n']),
      );
      commit(root, touched, '2021-06-01T00:00:00Z');
      plant([{ path: 'src/quiet.ts', symbols: ['keep'] }]);
      expect((await run()).code).toBe(0);
      const doc = readDoc(join(root, OUT));
      const quiet = areaOf(doc, 'src/quiet.ts');
      expect(quiet.risk_score).toBe(0);
      expect(quiet.symbols).toEqual(['keep']);
      expect(doc.areas.filter((a) => a.path !== 'src/quiet.ts').length).toBe(
        25,
      );
    });

    it('drops a path gone from HEAD and says so', async () => {
      ranked(root);
      plant([{ path: 'gone/old.ts', symbols: ['charge'] }]);
      const res = await run();
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/not a tracked file.*gone\/old\.ts/);
      const doc = readDoc(join(root, OUT));
      expect(doc.areas.map((a) => a.path)).not.toContain('gone/old.ts');
    });

    it('lists a tracked non-candidate without counting it as analyzed', async () => {
      ranked(root);
      commit(root, { 'tests/x.test.ts': "import '../src/a.js';\n" });
      plant([{ path: 'tests/x.test.ts', symbols: ['spec'] }]);
      expect((await run()).code).toBe(0);
      const doc = readDoc(join(root, OUT));
      expect(areaOf(doc, 'tests/x.test.ts').symbols).toEqual(['spec']);
      expect(doc.files_analyzed).toBe(2);
    });

    it('counts an importer of a kept extra, but no test as an importer', async () => {
      git(root, ['init', '-q']);
      commit(root, {
        'src/uses.ts': "import '../tests/helper.js';\n",
        'src/other.ts': 'export {};\n',
        'tests/helper.ts': 'export {};\n',
        'tests/x.test.ts': "import '../src/other.js';\n",
      });
      plant([
        { path: 'tests/helper.ts', symbols: ['help'] },
        { path: 'tests/x.test.ts', symbols: ['spec'] },
      ]);
      expect((await run()).code).toBe(0);
      const doc = readDoc(join(root, OUT));
      expect(areaOf(doc, 'tests/helper.ts').importers).toBe(1);
      expect(areaOf(doc, 'tests/x.test.ts').importers).toBe(0);
      expect(areaOf(doc, 'src/other.ts').importers).toBe(0);
    });

    it('says a directory path is not a tracked file, not that it left HEAD', async () => {
      ranked(root);
      plant([{ path: 'src', symbols: ['charge'] }]);
      const res = await run();
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(
        'Dropped symbols for paths that are not a tracked file in HEAD: src.',
      );
      expect(res.stdout).not.toContain('no longer in HEAD');
    });

    it.each([
      ['too short', ['ab']],
      ['blank', ['  ']],
      ['short once normalized', ['a-b']],
      ['one bad among good', ['chargeCard', 'ab']],
    ])('does not carry a list katana rejects: %s', async (_name, symbols) => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols }]);
      const res = await run();
      expect(res.code).toBe(0);
      expect('symbols' in areaOf(readDoc(join(root, OUT)), 'src/a.ts')).toBe(
        false,
      );
      const lines = res.stdout
        .split('\n')
        .filter((l) => l.includes('src/a.ts'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/under 3 letters or digits/);
    });

    it('keeps a three-character symbol, the shortest katana accepts', async () => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols: ['a-bc'] }]);
      const res = await run();
      expect(areaOf(readDoc(join(root, OUT)), 'src/a.ts').symbols).toEqual([
        'a-bc',
      ]);
      expect(res.stdout).not.toContain('under 3 letters');
    });

    it('overwrites a malformed existing file (D17)', async () => {
      ranked(root);
      mkdirSync(join(root, '.canary'));
      writeFileSync(join(root, OUT), 'not json', 'utf-8');
      expect((await run()).code).toBe(0);
      expect(readDoc(join(root, OUT)).areas.length).toBeGreaterThan(0);
    });

    it.each([
      ['empty', []],
      ['non-string', [1]],
      ['empty-string', ['']],
      ['not an array', 'charge'],
    ])('does not carry a %s symbols value', async (_name, symbols) => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols }]);
      expect((await run()).code).toBe(0);
      const a = areaOf(readDoc(join(root, OUT)), 'src/a.ts');
      expect('symbols' in a).toBe(false);
    });

    it('reads symbols from --out, not the default path', async () => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols: ['fromDefault'] }]);
      const out = join(root, 'other.json');
      plant([{ path: 'src/b.ts', symbols: ['fromOut'] }], out);
      const res = await invokeCanary([
        'critical-areas',
        '--root',
        root,
        '--out',
        out,
      ]);
      expect(res.code).toBe(0);
      const doc = readDoc(out);
      expect(areaOf(doc, 'src/b.ts').symbols).toEqual(['fromOut']);
      expect(areaOf(doc, 'src/a.ts').symbols).toBeUndefined();
    });

    it('stays deterministic with symbols (criterion 10)', async () => {
      ranked(root);
      plant([{ path: 'src/a.ts', symbols: ['charge'] }]);
      await run();
      const first = readDoc(join(root, OUT));
      expect(areaOf(first, 'src/a.ts').symbols).toEqual(['charge']);
      await run();
      const second = readDoc(join(root, OUT));
      expect({ ...first, generated: '' }).toEqual({
        ...second,
        generated: '',
      });
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

  describe('source files that cannot be read (D1)', () => {
    /** `a` has 2 importers and 2 commits; `b` 1 and 1; `c` 0 and 1. */
    function threeFiles(repo: string): void {
      git(repo, ['init', '-q']);
      commit(repo, {
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
        'src/c.ts': "import { a } from './a.js';\nimport './b.js';\n",
      });
      commit(repo, { 'src/a.ts': 'export const a = 2;\n' });
    }

    /** Leaves every tracked file out of the working tree, as a real user can. */
    const emptyTree = (repo: string): void => {
      git(repo, ['sparse-checkout', 'set', '--no-cone', '/README']);
      expect(existsSync(join(repo, 'src'))).toBe(false);
    };

    it('records every file read when all of them were', async () => {
      threeFiles(root);
      await invokeCanary(['critical-areas', '--root', root]);
      const doc = readDoc(join(root, OUT));
      expect(doc.signal_sources.importers).toEqual({
        status: 'measured',
        files_read: 3,
        files_unread: 0,
      });
      expect(areaOf(doc, 'src/a.ts').importers).toBe(2);
    });

    it('writes null importers and scores on churn when nothing could be read', async () => {
      threeFiles(root);
      emptyTree(root);
      const res = await invokeCanary(['critical-areas', '--root', root]);
      expect(res.code).toBe(0);
      const doc = readDoc(join(root, OUT));
      const source = doc.signal_sources.importers!;
      expect(source.status).toBe('absent');
      expect(source.reason).toMatch(/0 of 3/);
      expect(source.files_read).toBe(0);
      expect(source.files_unread).toBe(3);
      for (const area of doc.areas) expect(area.importers).toBeNull();
      const a = areaOf(doc, 'src/a.ts');
      // Churn alone carries the weight, as importers do for a null churn.
      expect(a.risk_score).toBe(1);
      expect(a.churn_commits).toBe(2);
      expect(areaOf(doc, 'src/b.ts').risk_score).toBe(0.5);
      expect(a.signals).not.toContain('many_dependents');
      expect(a.recommended_test_types).toEqual(['unit']);
      expect(a.summary).toContain('importers not measured');
      expect(res.stdout).toMatch(/0 of 3/);
    });

    it('reports how many reads failed when only some did', async () => {
      threeFiles(root);
      rmSync(join(root, 'src', 'c.ts'));
      const res = await invokeCanary(['critical-areas', '--root', root]);
      expect(res.code).toBe(0);
      const doc = readDoc(join(root, OUT));
      const source = doc.signal_sources.importers!;
      expect(source.status).toBe('partial');
      expect(source.reason).toMatch(/1 of 3/);
      expect(source.files_read).toBe(2);
      expect(source.files_unread).toBe(1);
      // A lower bound from what could be read: `c` was one of `a`'s importers.
      expect(areaOf(doc, 'src/a.ts').importers).toBe(1);
      expect(res.stdout).toMatch(/1 of 3/);
    });

    it('abstains when neither churn nor importers could be measured', async () => {
      const source = join(root, 'source');
      mkdirSync(source);
      threeFiles(source);
      const clone = shallowClone(root, source);
      emptyTree(clone);
      const res = await invokeCanary(['critical-areas', '--root', clone]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(existsSync(join(clone, OUT))).toBe(false);
    });
  });

  it('writes the same document under log.showRoot=false', async () => {
    ranked(root);
    const out = join(root, 'areas.json');
    const run = async (): Promise<Doc> => {
      await invokeCanary(['critical-areas', '--root', root, '--out', out]);
      return { ...readDoc(out), generated: '' };
    };
    const before = await run();
    git(root, ['config', 'log.showRoot', 'false']);
    expect(await run()).toEqual(before);
    expect(areaOf(before, 'src/b.ts').churn_commits).toBe(1);
  });
});
