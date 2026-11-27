/**
 * `canary evidence export` (#855), driven through the command with a fixed
 * clock and a fake `git rev-parse HEAD`. Fixtures are synthetic: an
 * `acme/widgets` repository in a temp root.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { buildEvidenceCommand } from '../src/evidence/cli.js';
import type { EvidencePack } from '../src/analysis/evidence/types.js';
import { defaultMainDeps, type MainDeps } from '../src/main-deps.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const HEAD = 'd'.repeat(40);
const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');
const CONTROLS = [
  'nist-800-40r4-2.3.3',
  'nist-800-40r4-2.3.4',
  'iso-27001-2022-a.8.8',
  'cis-v8-7',
  'soc2-cc7.1',
  'soc2-cc8.1',
];

let root: string;

beforeEach(() => {
  root = mkTmp();
});

afterEach(() => rmTmp(root));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
  over: Partial<MainDeps> = {},
): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    ...defaultMainDeps(),
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: {},
    cwd: () => root,
    runSubprocess: () => ({ status: 0, stdout: `${HEAD}\n`, stderr: '' }),
    ...over,
  };
  let code = 0;
  try {
    const command = buildEvidenceCommand(deps, () => NOW);
    await command.parseAsync(['export', ...args], { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else throw e;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function storedRun(id: string, timestamp: string): string {
  return `${JSON.stringify({
    run_id: id,
    suite: 'api',
    commit_sha: 'a'.repeat(40),
    timestamp,
    total: 3,
    passed: 3,
    failed: 0,
    flaky: 0,
    duration_ms: 1000,
    schema_version: 3,
    tests: [],
  })}\n`;
}

/** One record in every file-backed source, all dated inside 2026. */
function seedAllSources(): void {
  write(HISTORY, storedRun('r1', '2026-03-01T00:00:00.000Z'));
  write(
    join('.canary', 'quarantine.json'),
    JSON.stringify({
      schema_version: 2,
      entries: [
        {
          test: 'adds a widget',
          file: 'tests/widgets.test.ts',
          kind: 'skipped',
          commit: 'b'.repeat(40),
          author: 'Sam Example',
          date: '2026-03-02T00:00:00Z',
          cause: 'blocked-data',
        },
      ],
    }),
  );
  write(
    join('.canary', 'batwoman', '12.json'),
    JSON.stringify({
      issue: 12,
      pullRequest: 34,
      repo: 'acme/widgets',
      mergeSha: 'c'.repeat(40),
      mergedAt: '2026-03-03T00:00:00.000Z',
      files: [{ file: 'src/a.ts', status: 'not-exercised' }],
    }),
  );
}

function readPack(dir = join(root, '.canary', 'evidence')): EvidencePack {
  const text = readFileSync(join(dir, 'evidence-pack.json'), 'utf-8');
  return JSON.parse(text) as EvidencePack;
}

function readMarkdown(dir = join(root, '.canary', 'evidence')): string {
  return readFileSync(join(dir, 'evidence-pack.md'), 'utf-8');
}

describe('canary evidence export', () => {
  it('writes both files with all six controls when every source is empty (criterion 1)', async () => {
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    expect(pack.controls.map((c) => c.id)).toEqual(CONTROLS);
    expect(pack.controls.every((c) => c.status === 'no-evidence')).toBe(true);
    const md = readMarkdown();
    for (const id of CONTROLS) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${id} |`));
      expect(row, id).toContain('NO EVIDENCE');
      expect(res.stdout).toContain(`${id}  NO EVIDENCE`);
    }
  });

  it('links every item and maps it to a control, across all four sources (criterion 4)', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    expect(pack.items.map((i) => i.source).sort()).toEqual([
      'batwoman',
      'ci-ready',
      'history',
      'katana',
    ]);
    for (const item of pack.items) {
      expect(item.ref.id, item.source).not.toBe('');
      expect(item.controls.length, item.source).toBeGreaterThan(0);
    }
    expect(pack.sources.map((s) => s.state)).toEqual([
      'read',
      'read',
      'read',
      'read',
    ]);
    expect(res.stdout).toContain('soc2-cc8.1  evidence: 3');
    expect(res.stdout).toContain('cis-v8-7  evidence: 1');
  });

  it('ends the window at the export time when --until is omitted (criterion 7)', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01']);
    const pack = readPack();
    expect(pack.window).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-06-15T12:00:00.000Z',
    });
    expect(pack.generated_at).toBe('2026-06-15T12:00:00.000Z');
    expect(pack.commit).toBe(HEAD);
  });

  it('dates the ci-ready item at the export and links it to HEAD (D10)', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01', '--repo', 'acme/widgets']);
    const item = readPack().items.find((i) => i.source === 'ci-ready');
    expect(item?.at).toBe('2026-06-15T12:00:00.000Z');
    expect(item?.ref).toEqual({
      kind: 'commit',
      id: HEAD,
      url: `https://github.com/acme/widgets/commit/${HEAD}`,
    });
    expect(item?.summary).toMatch(/^ci-ready \S+: \d of 5 checks scored/);
  });

  it('reports ci-ready out-of-window when the export is after --until', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01', '--until', '2026-04-01']);
    const pack = readPack();
    const ciReady = pack.sources.find((s) => s.id === 'ci-ready');
    expect(ciReady).toMatchObject({ state: 'out-of-window', inWindow: 0 });
    expect(pack.items.some((i) => i.source === 'ci-ready')).toBe(false);
  });

  it('reports ci-ready unreadable when HEAD does not resolve', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01'], {
      runSubprocess: () => ({ status: 128, stdout: '', stderr: 'fatal' }),
    });
    const pack = readPack();
    expect(pack.commit).toBeNull();
    const ciReady = pack.sources.find((s) => s.id === 'ci-ready');
    expect(ciReady).toMatchObject({ state: 'unreadable' });
  });

  it('takes the repository from GITHUB_REPOSITORY when --repo is not given', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01'], {
      env: { GITHUB_REPOSITORY: 'acme/gadgets' },
    });
    const run1 = readPack().items.find((i) => i.source === 'history');
    expect(run1?.ref.url).toBe(
      `https://github.com/acme/gadgets/commit/${'a'.repeat(40)}`,
    );
  });

  it('replaces the previous pack in the same --out (criterion 10)', async () => {
    const out = join(root, 'packs');
    write(HISTORY, storedRun('first-run', '2026-03-01T00:00:00.000Z'));
    await run(['--since', '2026-01-01', '--out', out]);
    expect(readMarkdown(out)).toContain('first-run');
    write(HISTORY, storedRun('second-run', '2026-03-05T00:00:00.000Z'));
    await run(['--since', '2026-01-01', '--out', out]);
    const ids = readPack(out).items.map((i) => i.ref.id);
    expect(ids).toContain('second-run');
    expect(ids).not.toContain('first-run');
    expect(readMarkdown(out)).not.toContain('first-run');
  });

  it('prints root-relative source paths, never the absolute root', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    const text = JSON.stringify(readPack().sources) + readMarkdown();
    expect(text).not.toContain(root);
    expect(readPack().sources.map((s) => s.path)).toEqual([
      join('.canary', 'batwoman'),
      join('.canary', 'quarantine.json'),
      HISTORY,
      '.',
    ]);
    expect(res.stdout).toContain(
      `Wrote ${join(root, '.canary', 'evidence', 'evidence-pack.json')}`,
    );
    expect(res.stdout).toContain('evidence-pack.md');
  });

  it.each([
    ['--since is not a date', ['--since', 'last week'], 'last week'],
    ['--since is a local date-time', ['--since', '2026-01-01T10:00'], 'T10:00'],
    ['--until is not a date', ['--since', '2026-01-01', '--until', 'x'], 'x'],
    [
      '--since is not before --until',
      ['--since', '2026-03-01', '--until', '2026-03-01'],
      '2026-03-01T00:00:00.000Z',
    ],
    ['--since is after the export time', ['--since', '2027-01-01'], '2027'],
    [
      '--repo is not a slug',
      ['--since', '2026-01-01', '--repo', 'acme'],
      'acme',
    ],
  ])('exits 2 naming the value when %s', async (_name, args, named) => {
    const res = await run(args);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(named);
    expect(existsSync(join(root, '.canary', 'evidence'))).toBe(false);
  });

  it('exits 2 when --root does not exist', async () => {
    const missing = join(root, 'no-such-root');
    const res = await run(['--since', '2026-01-01', '--root', missing]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(missing);
  });
});

describe('canary evidence export: sources that are missing or broken', () => {
  it('keeps the other controls fed when the history store is corrupt (criterion 2)', async () => {
    seedAllSources();
    write(HISTORY, `${storedRun('r1', '2026-03-01T00:00:00.000Z')}{not json\n`);
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    const history = pack.sources.find((s) => s.id === 'history');
    expect(history?.state).toBe('unreadable');
    expect(history?.reason).toContain('line 2');
    const byId = new Map(pack.controls.map((c) => [c.id, c]));
    expect(byId.get('cis-v8-7')).toMatchObject({
      status: 'evidence',
      items: 1,
    });
    expect(byId.get('soc2-cc8.1')).toMatchObject({ status: 'evidence' });
    expect(res.stdout).toContain('source history: unreadable (');
    expect(res.stdout).toContain('line 2');
  });

  it('reports each missing default path as absent, with a reason (criterion 3)', async () => {
    const res = await run(['--since', '2026-01-01']);
    const pack = readPack();
    for (const id of ['batwoman', 'katana', 'history']) {
      const source = pack.sources.find((s) => s.id === id);
      expect(source?.state, id).toBe('absent');
      expect(source?.reason, id).not.toBe('');
      expect(res.stdout).toContain(`source ${id}: absent (`);
    }
  });

  it('exits 2 when --batwoman names a missing directory (criterion 3)', async () => {
    const typo = join(root, 'batwomann');
    const res = await run(['--since', '2026-01-01', '--batwoman', typo]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(typo);
    expect(existsSync(join(root, '.canary', 'evidence'))).toBe(false);
  });

  it('reads saved reports from a --batwoman directory outside the default', async () => {
    const dir = join(root, 'saved');
    write(
      join('saved', '7.json'),
      JSON.stringify({
        issue: 7,
        pullRequest: 8,
        mergeSha: 'c'.repeat(40),
        mergedAt: '2026-03-03T00:00:00.000Z',
        files: [],
      }),
    );
    await run(['--since', '2026-01-01', '--batwoman', dir]);
    const source = readPack().sources.find((s) => s.id === 'batwoman');
    expect(source).toMatchObject({ path: dir, state: 'read', inWindow: 1 });
  });

  it('warns, names the cause and the first step, and still exits 0 when nothing produced an item (criterion 9)', async () => {
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    expect(
      existsSync(join(root, '.canary', 'evidence', 'evidence-pack.md')),
    ).toBe(true);
    const warning = res.stdout.split('\n').find((l) => l.includes('Abstained'));
    expect(warning).toContain('No source produced an item in the window');
    expect(warning).toContain('history absent');
    expect(warning).toContain('First step: record a run with');
    expect(res.stdout).not.toContain('evidence: ');
  });

  it('does not warn when at least one source produced an item', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    expect(res.stdout).not.toContain('Abstained');
  });

  it('exits 1 naming the path and errno when --out cannot be created', async () => {
    write('blocker', 'a file where the directory should go');
    const out = join(root, 'blocker', 'packs');
    const res = await run(['--since', '2026-01-01', '--out', out]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(out);
    expect(res.stderr).toMatch(/ENOTDIR|EEXIST/);
    expect(res.stdout).not.toContain('Wrote');
  });
});
