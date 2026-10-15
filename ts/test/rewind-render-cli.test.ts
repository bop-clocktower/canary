/**
 * `canary rewind` text/JSON report (#461 PR 2) and the CLI's abstain ladder.
 *
 * The render half is pure: reports are built by hand. The abstain ladder needs
 * a real repository for the rungs that ask git (not a repository, non-hex
 * commit id, worktree add failure); it is built once with the shared fixture
 * builder and copied per test (#1261), and every rung abstains before a runner
 * would start, so no replay runs here.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CommanderError } from 'commander';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  renderRewind,
  type RewindReport,
} from '../src/analysis/rewind/render.js';
import { CliExitError } from '../src/cli-common.js';
import type { RunRecord } from '../src/history/record.js';
import type { MainDeps } from '../src/main-deps.js';
import {
  buildRewindCommand,
  runRewind,
  type RewindDeps,
} from '../src/rewind/rewind-cli.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';
import {
  GIT_TEMPLATE_BUILD_TIMEOUT_MS,
  buildGitTemplate,
  copyGitTemplate,
  removeGitFixture,
} from './git-fixture-testkit.js';

const HOST = { node: 'v22.23.2', os: 'linux', arch: 'x64' };
const FAIL_SHA = 'b'.repeat(40);
const GREEN_SHA = 'a'.repeat(40);

function report(over: Partial<RewindReport> = {}): RewindReport {
  return {
    runId: 'fail',
    test: 'adds',
    commit: FAIL_SHA,
    fidelity: [{ dimension: 'commit', status: 'restored', reason: 'ok' }],
    attempts: 3,
    statuses: ['failed', 'failed', 'failed'],
    outcome: 'reproduced',
    recorded: { test_name: 'adds', status: 'failed' },
    green: null,
    ...over,
  };
}

function greenRun(): RunRecord {
  return {
    run_id: 'green',
    suite: 's',
    schema_version: 3,
    commit_sha: GREEN_SHA,
    tests: [{ test_name: 'adds', status: 'passed', duration_ms: 10 }],
  };
}

/** A green run that recorded neither a commit nor any tests. */
const BARE_GREEN: RunRecord = {
  run_id: 'green',
  suite: 's',
  schema_version: 3,
};

const text = (r: RewindReport): string[] => renderRewind(r, false).split('\n');

describe('renderRewind: text result line', () => {
  it.each([
    [[], 'none reported'],
    [['skipped', 'pending'], 'skipped, pending'],
  ])('a not-run replay with statuses %j says %s', (statuses, shown) => {
    const lines = text(report({ outcome: 'not-run', statuses }));
    expect(lines).toContain(
      `Result: not-run (no attempt ran the test; statuses: ${shown}; see the environment row)`,
    );
  });

  it('counts failures over attempts that ran, ignoring skipped and pending', () => {
    const statuses = ['failed', 'skipped', 'passed', 'pending', 'errored'];
    const lines = text(report({ outcome: 'intermittent', statuses }));
    expect(lines).toContain('Result: intermittent (2 of 3 attempts failed)');
  });

  it('hands an intermittent result off to the flakiness tools', () => {
    const out = renderRewind(report({ outcome: 'intermittent' }), false);
    expect(out).toMatch(/\n\nIntermittent: hand off to `canary history flaky`/);
  });

  it('carries no flakiness hand-off on a reproduced result', () => {
    expect(renderRewind(report(), false)).not.toContain('Intermittent:');
  });
});

describe('renderRewind: text nearest green', () => {
  it('says so when no green run is on first-parent history', () => {
    expect(text(report())).toContain(
      'Nearest green: none recorded on first-parent history',
    );
  });

  it('names the green run, the commit span, durations and the first error line', () => {
    const lines = text(
      report({
        green: { run: greenRun(), distance: 2 },
        recorded: {
          test_name: 'adds',
          status: 'failed',
          duration_ms: 30,
          error_text: 'expected 3\n  at a.test.ts:1',
        },
      }),
    );
    expect(lines.slice(-4)).toEqual([
      `Nearest green: green at ${'a'.repeat(12)} (2 commit(s) back)`,
      `  commits: ${'a'.repeat(12)}..${'b'.repeat(12)}`,
      '  duration: 10ms green -> 30ms failing',
      '  error when failing: expected 3',
    ]);
  });

  it('marks durations and the error unknown when none were recorded', () => {
    const run: RunRecord = { ...BARE_GREEN, tests: [] };
    const lines = text(report({ green: { run, distance: 1 } }));
    expect(lines.slice(-4)).toEqual([
      'Nearest green: green at  (1 commit(s) back)',
      `  commits: ..${'b'.repeat(12)}`,
      '  duration: unknown green -> unknown failing',
      '  error when failing: (none recorded)',
    ]);
  });
});

describe('renderRewind: JSON', () => {
  it('reports a null nearest green and null recorded fields when absent', () => {
    const payload = JSON.parse(renderRewind(report(), true)) as unknown;
    expect(payload).toMatchObject({
      nearestGreen: null,
      recorded: { error_text: null, duration_ms: null },
    });
  });

  it('nulls the green commit and duration when the green run lacks them', () => {
    const green = { run: BARE_GREEN, distance: 4 };
    const out = renderRewind(report({ green }), true);
    expect(JSON.parse(out)).toMatchObject({
      nearestGreen: {
        run_id: 'green',
        commit: null,
        distance: 4,
        duration_ms: null,
      },
    });
  });
});

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

let template: string;
let headSha: string;
let repo: string;

/**
 * One commit holding a test file; built once, copied per test (#1261).
 * Registered only inside the ladder describe, so the pure render tests above
 * pay no git spawn.
 */
function useGitRepo(): void {
  beforeAll(() => {
    template = buildGitTemplate('rewind-ladder-tpl-', (dir) => {
      git(dir, 'init', '-q', '-b', 'main');
      mkdirSync(join(dir, 'test'));
      writeFileSync(join(dir, 'test', 'a.test.ts'), '// v1\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'c1');
      headSha = git(dir, 'rev-parse', 'HEAD');
    });
  }, GIT_TEMPLATE_BUILD_TIMEOUT_MS);
  afterAll(() => {
    removeGitFixture(template);
  });
  beforeEach(() => {
    repo = copyGitTemplate(template, 'rewind-ladder-');
  });
  afterEach(() => {
    removeGitFixture(repo);
  });
}

function failingRun(commit: string): RunRecord {
  return {
    run_id: 'fail',
    suite: 's',
    commit_sha: commit,
    reporter_format: 'vitest',
    schema_version: 3,
    tests: [
      { test_name: 'adds', status: 'failed', test_file: 'test/a.test.ts' },
    ],
  };
}

interface Ladder {
  deps: RewindDeps;
  out: string[];
  execs: number;
}

/** Deps over a real cwd; the runner is a counter that must stay at zero. */
function ladder(cwd: string, commit: string): Ladder {
  const out: string[] = [];
  const h: Ladder = {
    out,
    execs: 0,
    deps: {
      out: (s) => out.push(s),
      err: (s) => out.push(s),
      cwd: () => cwd,
      host: HOST,
      readRuns: async () => [failingRun(commit)],
      exec: async () => {
        h.execs++;
        return { code: 0, output: '' };
      },
    },
  };
  return h;
}

const OPTS = {
  runId: 'fail',
  test: 'adds',
  repeat: 1,
  withPredecessors: false,
  json: false,
};

async function abstainOn(h: Ladder): Promise<string> {
  expect(await runRewind(OPTS, h.deps)).toBe(3);
  expect(h.execs).toBe(0);
  return h.out.join('\n');
}

describe('runRewind: abstain ladder', () => {
  useGitRepo();

  it('abstains outside a git repository', async () => {
    const outside = mkTmp();
    try {
      const out = await abstainOn(ladder(outside, headSha));
      expect(out).toBe('Abstained: not inside a git repository');
    } finally {
      rmTmp(outside);
    }
  });

  it('abstains on a commit id that is not hexadecimal', async () => {
    const out = await abstainOn(ladder(repo, '--output=x'));
    expect(out).toBe(
      "Abstained: commit '--output=x' is not a hexadecimal commit id",
    );
  });

  it('abstains when the scratch worktree cannot be added', async () => {
    // A plain file where git keeps its worktree metadata: `worktree add` fails.
    writeFileSync(join(repo, '.git', 'worktrees'), '');
    const out = await abstainOn(ladder(repo, headSha));
    expect(out).toBe(
      `Abstained: could not check out ${headSha} into a scratch worktree`,
    );
  });
});

/** Parse argv through the real command without exiting the process. */
async function parseRewind(repeat: string): Promise<unknown> {
  const out: string[] = [];
  const cmd = buildRewindCommand({} as MainDeps, {
    out: (s) => out.push(s),
    readRuns: async () => null,
  })
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const argv = ['nope', '--test', 'x', '--repeat', repeat, '--path', 'h.jsonl'];
  return cmd.parseAsync(argv, { from: 'user' }).catch((e: unknown) => e);
}

describe('canary rewind --repeat bounds', () => {
  it.each(['1', '20'])('accepts --repeat %s and runs the rewind', async (n) => {
    // The stubbed store abstains, so reaching exit 3 proves the parse passed.
    const err = await parseRewind(n);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(3);
  });

  it.each(['0', '21', '2.5', 'many'])('rejects --repeat %s', async (n) => {
    const err = await parseRewind(n);
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).message).toContain(
      `--repeat must be 1-20, got "${n}"`,
    );
  });
});
