/**
 * `canary rewind` orchestration (#461 PR 2) against a REAL git repository,
 * with only the test runner faked. Proposal criteria 4, 8, 9 and 10: abstain
 * without creating a worktree, classify repeats, leave the user's tree and
 * branch exactly as they were, and never exit 1.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import type { RunRecord } from '../src/history/record.js';
import type { MainDeps } from '../src/main-deps.js';
import {
  buildRewindCommand,
  runRewind,
  type RewindDeps,
  type RewindOptions,
} from '../src/rewind/rewind-cli.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';
import {
  GIT_TEMPLATE_BUILD_TIMEOUT_MS,
  buildGitTemplate,
  copyGitTemplate,
  removeGitFixture,
} from './git-fixture-testkit.js';

const HOST = { node: 'v22.23.2', os: 'linux', arch: 'x64' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf-8' },
  ).trim();
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

let repo: string;
let shas: string[];

let template: string;

/**
 * Three first-parent commits; node_modules present so no install runs. Built
 * ONCE per file and copied per test (#1245): built per test it was ten
 * `git` spawns in a `beforeEach`, which ran past vitest's 10 s hook timeout
 * under load. The copy has the same objects, so `shas` holds for every test.
 */
beforeAll(() => {
  template = buildGitTemplate('rewind-replay-tpl-', (dir) => {
    git(dir, 'init', '-q', '-b', 'main');
    shas = [];
    for (const n of [1, 2, 3]) {
      write(join(dir, 'test', 'a.test.ts'), `// v${n}\n`);
      write(join(dir, 'package.json'), '{}');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `c${n}`);
      shas.push(git(dir, 'rev-parse', 'HEAD'));
    }
  });
}, GIT_TEMPLATE_BUILD_TIMEOUT_MS);

afterAll(() => {
  removeGitFixture(template);
});

beforeEach(() => {
  repo = copyGitTemplate(template, 'canary-cli-');
});

afterEach(() => {
  removeGitFixture(repo);
});

function failingRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'fail',
    suite: 's',
    commit_sha: shas[2]!,
    reporter_format: 'vitest',
    schema_version: 3,
    replay: {
      seed: null,
      seed_source: null,
      runner: { name: 'vitest', version: null },
      ...HOST,
      ci: null,
      commit_source: 'flag',
    },
    tests: [
      {
        test_name: 'adds',
        status: 'failed',
        test_file: 'test/a.test.ts',
        error_text: 'expected 3',
        duration_ms: 30,
      },
    ],
    ...over,
  };
}

interface Harness {
  deps: RewindDeps;
  out: string[];
  execCalls: { cwd: string; args: string[] }[];
}

/** What the fake runner writes: one vitest report holding one status. */
function writeVitestReport(args: string[], cwd: string, status: string): void {
  const report = args.find((a) => a.startsWith('--outputFile='))!;
  const file = { name: join(cwd, 'test/a.test.ts') };
  const results = [
    { ...file, assertionResults: [{ fullName: 'adds', status }] },
  ];
  writeFileSync(
    report.slice('--outputFile='.length),
    JSON.stringify({ testResults: results }),
  );
}

function harness(runs: RunRecord[] | null, statuses: string[]): Harness {
  const out: string[] = [];
  const execCalls: { cwd: string; args: string[] }[] = [];
  let i = 0;
  const deps: RewindDeps = {
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    cwd: () => repo,
    host: HOST,
    readRuns: async () => runs,
    exec: async (_cmd, args, opts) => {
      execCalls.push({ cwd: opts.cwd, args });
      // The worktree has no node_modules, so the fake install must create it.
      if (args[0] === 'ci') {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
        return { code: 0, output: '' };
      }
      const status = statuses[i++] ?? 'passed';
      writeVitestReport(args, opts.cwd, status);
      return { code: status === 'failed' ? 1 : 0, output: '' };
    },
  };
  return { deps, out, execCalls };
}

const opts = (over: Partial<RewindOptions> = {}): RewindOptions => ({
  runId: 'fail',
  test: 'adds',
  repeat: 3,
  withPredecessors: false,
  json: false,
  ...over,
});

function treeState(): string {
  return [
    git(repo, 'worktree', 'list', '--porcelain'),
    git(repo, 'branch', '--show-current'),
    git(repo, 'status', '--porcelain'),
    git(repo, 'rev-parse', 'HEAD'),
  ].join('\n---\n');
}

describe('runRewind: abstention (criterion 4)', () => {
  it.each([
    ['an absent run', () => [failingRun()], { runId: 'nope' }],
    ['an absent test', () => [failingRun()], { test: 'nope' }],
    ['a local commit', () => [failingRun({ commit_sha: 'local' })], {}],
    [
      'an unreachable commit',
      () => [failingRun({ commit_sha: 'f'.repeat(40) })],
      {},
    ],
  ])('abstains on %s with exit 3 and no worktree', async (_l, runs, over) => {
    const before = treeState();
    const h = harness(runs(), []);
    const code = await runRewind(opts(over), h.deps);
    expect(code).toBe(3);
    expect(h.out.join('\n')).toMatch(/^Abstained: /m);
    expect(h.execCalls).toHaveLength(0);
    expect(treeState()).toBe(before);
  });

  it('abstains when the store cannot return whole runs', async () => {
    const h = harness(null, []);
    expect(await runRewind(opts(), h.deps)).toBe(3);
    expect(h.out.join('\n')).toMatch(/Abstained: .*whole run records/);
  });

  it('abstains on a test file that is not repo-relative', async () => {
    const run = failingRun();
    run.tests![0]!.test_file = '/elsewhere/a.test.ts';
    const h = harness([run], []);
    expect(await runRewind(opts(), h.deps)).toBe(3);
    expect(h.out.join('\n')).toMatch(/Abstained: .*not repo-relative/);
  });
});

describe('runRewind: a failure outside any test (#1411)', () => {
  const VITEST_NAME = 'test/a.test.ts (file failed outside any test)';
  const PW_NAME = 'test/a.spec.ts (file failed outside any test)';

  const syntheticRun = (runner: 'vitest' | 'playwright'): RunRecord =>
    failingRun({
      reporter_format: runner,
      tests: [
        {
          test_name: runner === 'vitest' ? VITEST_NAME : PW_NAME,
          status: 'failed',
          test_file: runner === 'vitest' ? 'test/a.test.ts' : 'test/a.spec.ts',
        },
      ],
    });

  /** Reports as the real runners write them: real paths, a row only on failure. */
  function report(
    runner: 'vitest' | 'playwright',
    cwd: string,
    failing: boolean,
  ): object {
    const dir = realpathSync(cwd);
    if (runner === 'vitest') {
      const name = join(dir, 'test/a.test.ts');
      return {
        testResults: [
          failing
            ? { name, status: 'failed', message: 'boom', assertionResults: [] }
            : { name, status: 'passed', message: '', assertionResults: [] },
        ],
      };
    }
    const file = join(dir, 'test/a.spec.ts');
    const config = { rootDir: dir };
    return failing
      ? {
          config,
          suites: [],
          errors: [{ message: 'Error: boom', location: { file } }],
        }
      : {
          config,
          errors: [],
          suites: [{ title: 'test/a.spec.ts', file: 'test/a.spec.ts' }],
        };
  }

  function synthetic(runner: 'vitest' | 'playwright', fails: boolean[]) {
    const h = harness([syntheticRun(runner)], []);
    let i = 0;
    h.deps.exec = async (_cmd, args, execOpts) => {
      const failing = fails[i++] === true;
      const path =
        execOpts.env['PLAYWRIGHT_JSON_OUTPUT_NAME'] ??
        args.find((a) => a.startsWith('--outputFile='))!.slice(13);
      writeFileSync(
        path,
        JSON.stringify(report(runner, execOpts.cwd, failing)),
      );
      return { code: failing ? 1 : 0, output: '' };
    };
    return h;
  }

  const outcome = async (
    runner: 'vitest' | 'playwright',
    fails: boolean[],
  ): Promise<{ statuses: string[]; outcome: string }> => {
    const h = synthetic(runner, fails);
    const test = runner === 'vitest' ? VITEST_NAME : PW_NAME;
    const code = await runRewind(
      opts({ test, repeat: fails.length, json: true }),
      h.deps,
    );
    expect(code).toBe(0);
    return JSON.parse(h.out.join('\n')) as {
      statuses: string[];
      outcome: string;
    };
  };

  it.each(['vitest', 'playwright'] as const)(
    '%s: one load failure in five attempts is intermittent, not reproduced',
    async (runner) => {
      const got = await outcome(runner, [true, false, false, false, false]);
      expect(got.statuses).toEqual([
        'failed',
        'passed',
        'passed',
        'passed',
        'passed',
      ]);
      expect(got.outcome).toBe('intermittent');
    },
  );

  it.each(['vitest', 'playwright'] as const)(
    '%s: every attempt loading cleanly is not-reproduced',
    async (runner) => {
      const got = await outcome(runner, [false, false, false]);
      expect(got.outcome).toBe('not-reproduced');
    },
  );

  it.each(['vitest', 'playwright'] as const)(
    '%s: failing on every attempt is reproduced',
    async (runner) => {
      const got = await outcome(runner, [true, true, true]);
      expect(got.outcome).toBe('reproduced');
    },
  );

  // macOS `/var` is a symlink, and a runner reports the real path. Pointing
  // TMPDIR at a link gives every platform the same trap.
  it.skipIf(process.platform === 'win32')(
    'anchors at the real path when the scratch directory is behind a link',
    async () => {
      const link = join(repo, '..', `${repo.split(/[\\/]/).pop()}-tmp-link`);
      symlinkSync(realpathSync(dirname(repo)), link);
      const before = process.env['TMPDIR'];
      process.env['TMPDIR'] = link;
      try {
        const got = await outcome('vitest', [true, false]);
        expect(got.statuses).toEqual(['failed', 'passed']);
      } finally {
        if (before === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = before;
        removeGitFixture(link);
      }
    },
  );

  it('says a run-level failure has no file, not that it predates #1021', async () => {
    const run = failingRun();
    const name = '(run failed outside any test)';
    run.tests![0] = { test_name: name, status: 'failed', test_file: '' };
    const h = harness([run], []);
    expect(await runRewind(opts({ test: name }), h.deps)).toBe(3);
    const text = h.out.join('\n');
    expect(text).toMatch(/Abstained: .*names no test file/);
    expect(text).not.toContain('#1021');
    expect(text).not.toContain('not repo-relative');
    expect(h.execCalls).toHaveLength(0);
  });
});

describe('runRewind: path and output hygiene', () => {
  it('abstains on a test file that climbs out of the repository', async () => {
    const run = failingRun();
    run.tests![0]!.test_file = '../outside/a.test.ts';
    const h = harness([run], []);
    expect(await runRewind(opts(), h.deps)).toBe(3);
    expect(h.out.join('\n')).toMatch(/Abstained: .*outside the repository/);
    expect(h.execCalls).toHaveLength(0);
  });

  it('prints an abstention as JSON under --json', async () => {
    const h = harness([failingRun()], []);
    expect(await runRewind(opts({ json: true, runId: 'nope' }), h.deps)).toBe(
      3,
    );
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      abstained: true,
      reason: expect.stringContaining("run 'nope'"),
    });
  });
});

describe('runRewind: replay', () => {
  it('reproduces a failure at the recorded commit, in a scratch worktree', async () => {
    const before = treeState();
    const h = harness([failingRun()], ['failed', 'failed', 'failed']);
    const code = await runRewind(opts(), h.deps);
    expect(code).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('reproduced');
    expect(text).toMatch(/commit\s+restored/);
    const runCalls = h.execCalls.filter((c) => c.args[0] === 'vitest');
    expect(runCalls).toHaveLength(3);
    expect(runCalls[0]!.cwd).not.toBe(repo);
    // criterion 9: nothing left behind, nothing moved.
    expect(treeState()).toBe(before);
    expect(existsSync(dirname(runCalls[0]!.cwd))).toBe(false);
  });

  /** First attempt fails; the rest write no report (a crash or timeout). */
  function failThenUnreadable(): Harness {
    const h = harness([failingRun()], ['failed']);
    const fake = h.deps.exec;
    let runs = 0;
    h.deps.exec = async (cmd, args, execOpts) => {
      if (args[0] === 'ci' || runs++ === 0) return fake(cmd, args, execOpts);
      return { code: 1, output: 'runner crashed' };
    };
    return h;
  }

  it('#1584: one failure plus unreadable attempts discloses the dropped ones in text', async () => {
    const h = failThenUnreadable();
    expect(await runRewind(opts({ repeat: 5 }), h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      'Result: reproduced (1 of 1 attempts failed; 4 of 5 requested attempts not counted: unreadable, skipped or pending)',
    );
  });

  it('#1584: one failure plus unreadable attempts discloses the dropped ones in JSON', async () => {
    const h = failThenUnreadable();
    expect(await runRewind(opts({ repeat: 5, json: true }), h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      attempts: 5,
      statuses: ['failed'],
      dropped: 4,
      outcome: 'reproduced',
    });
  });

  it('criterion 8: an intermittent result carries the flakiness hand-off', async () => {
    const h = harness([failingRun()], ['failed', 'passed', 'failed']);
    expect(await runRewind(opts(), h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('intermittent');
    expect(text).toMatch(/canary history flaky/);
  });

  it('names the nearest green run and diffs it', async () => {
    const green: RunRecord = {
      ...failingRun(),
      run_id: 'green',
      commit_sha: shas[0]!,
      tests: [
        {
          test_name: 'adds',
          status: 'passed',
          test_file: 'test/a.test.ts',
          duration_ms: 10,
        },
      ],
    };
    const h = harness([green, failingRun()], ['failed', 'failed', 'failed']);
    await runRewind(opts({ json: true }), h.deps);
    const payload = JSON.parse(h.out.join('\n')) as {
      outcome: string;
      nearestGreen: { run_id: string; distance: number } | null;
      fidelity: { dimension: string; status: string }[];
    };
    expect(payload.outcome).toBe('reproduced');
    expect(payload.nearestGreen).toMatchObject({
      run_id: 'green',
      distance: 2,
    });
    expect(payload.fidelity).toHaveLength(7);
  });

  it('installs dependencies when the worktree has none', async () => {
    write(join(repo, 'package-lock.json'), '{}');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'lock');
    const run = failingRun({ commit_sha: git(repo, 'rev-parse', 'HEAD') });
    const h2 = harness([run], ['failed']);
    expect(await runRewind(opts({ repeat: 1 }), h2.deps)).toBe(0);
    expect(h2.execCalls[0]!.args).toEqual(['ci']);
    expect(h2.execCalls[1]!.args[0]).toBe('vitest');
  });

  it('criterion 10: an unexpected error abstains instead of exiting 1', async () => {
    const h = harness([failingRun()], []);
    h.deps.exec = async () => {
      throw new Error('boom');
    };
    const before = treeState();
    expect(await runRewind(opts(), h.deps)).toBe(3);
    expect(h.out.join('\n')).toMatch(/Abstained: .*boom/);
    expect(treeState()).toBe(before);
  });
});

describe('canary rewind (CLI)', () => {
  it('is registered and documents itself', async () => {
    const res = await invokeCanary(['rewind', '--help']);
    expect(res.code).toBe(0);
    // The harness does not capture commander's help text, so read it directly.
    const help = buildRewindCommand({} as MainDeps).helpInformation();
    expect(help).toContain('--with-predecessors');
    expect(help).toContain('--repeat');
  });

  it('criterion 10: an empty store abstains with 3, not 1', async () => {
    const dir = mkTmp();
    try {
      const res = await invokeCanary(
        ['rewind', 'nope', '--test', 'x', '--path', join(dir, 'h.jsonl')],
        { cwd: dir },
      );
      expect(res.code).toBe(3);
      expect(res.stdout + res.stderr).toContain('Abstained:');
    } finally {
      rmTmp(dir);
    }
  });
});
