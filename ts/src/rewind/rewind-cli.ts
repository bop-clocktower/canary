/**
 * `canary rewind <run_id> --test <name>` (#461 PR 2): rerun one failed test
 * from run history at its recorded commit, and say per dimension what was and
 * was not restored. The pure decisions live in `analysis/rewind/`; this
 * module owns the side effects (git, the scratch worktree, the runner) and
 * the commander wiring.
 *
 * Order matters for proposal criteria 4 and 9: every reason to abstain is
 * checked BEFORE a worktree exists, and the worktree lives under a scratch
 * directory removed in a `finally`, so the user's checkout, branch and
 * worktree list are unchanged on every exit.
 *
 * Exit codes: 0 when a replay completed (whatever it found), 3 when it
 * abstained, 2 for a usage error. Never 1: a reproduced failure is the
 * finding, not a failure of the command.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { Command, InvalidArgumentError, Option } from 'commander';

import {
  classifyRepeats,
  countedAttempts,
  fidelityRows,
  locateFailure,
  testFileProblem,
  nearestGreen,
  type HostFingerprint,
} from '../analysis/rewind/plan.js';
import { renderRewind, type RewindReport } from '../analysis/rewind/render.js';
import {
  readReplayStatus,
  replayCommand,
  type ReplayCommand,
  type ReplayRunner,
} from '../analysis/rewind/runner.js';
import {
  git,
  install,
  packageDir,
  predecessors,
  reachable,
  spawnExec,
  type ExecFn,
} from '../analysis/rewind/workspace.js';
import { CliExitError } from '../cli-common.js';
import type { RunRecord, TestResultRecord } from '../history/record.js';
import { makeStore } from '../history/store.js';
import type { MainDeps } from '../main-deps.js';
import { def } from '../util/coalesce.js';

export interface RewindOptions {
  runId: string;
  test: string;
  repeat: number;
  withPredecessors: boolean;
  json: boolean;
}

export interface RewindDeps {
  out(s: string): void;
  err(s: string): void;
  cwd(): string;
  host: HostFingerprint;
  /** Whole run records, or null when the backend cannot return them. */
  readRuns(): Promise<RunRecord[] | null>;
  exec: ExecFn;
}

const EXIT_OK = 0;
const EXIT_ABSTAINED = 3;

class Abstain extends Error {}

/** Run a rewind; resolves to the exit code (0 or 3, never 1). */
export async function runRewind(
  opts: RewindOptions,
  deps: RewindDeps,
): Promise<number> {
  try {
    const report = await rewind(opts, deps);
    deps.out(renderRewind(report, opts.json));
    return EXIT_OK;
  } catch (err) {
    const reason =
      err instanceof Abstain
        ? err.message
        : `internal error: ${(err as Error).message}`;
    deps.out(
      opts.json
        ? JSON.stringify({ abstained: true, reason }, null, 2)
        : `Abstained: ${reason}`,
    );
    return EXIT_ABSTAINED;
  }
}

async function rewind(
  opts: RewindOptions,
  deps: RewindDeps,
): Promise<RewindReport> {
  const runs = await deps.readRuns();
  if (runs === null) {
    throw new Abstain(
      'this history backend cannot return whole run records; rewind reads the local store',
    );
  }
  const found = locateFailure(runs, opts.runId, opts.test);
  if (!found.ok) throw new Abstain(found.reason);
  const { run, test } = found;
  const fileProblem = testFileProblem(test.test_file);
  if (fileProblem !== null) throw new Abstain(fileProblem);
  const top = git(deps.cwd(), ['rev-parse', '--show-toplevel']);
  if (top === null) throw new Abstain('not inside a git repository');
  const sha = run.commit_sha!;
  // The SHA reaches `git` as an argument; anything but hex could read as an option.
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Abstain(`commit '${sha}' is not a hexadecimal commit id`);
  }
  if (!reachable(top, sha)) {
    throw new Abstain(`commit ${sha} is unreachable, even after one fetch`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'canary-rewind-'));
  const tree = join(scratch, 'tree');
  try {
    if (git(top, ['worktree', 'add', '--detach', tree, sha]) === null) {
      throw new Abstain(`could not check out ${sha} into a scratch worktree`);
    }
    return await replayInTree({
      opts,
      deps,
      runs,
      run,
      test,
      tree,
      scratch,
      top,
    });
  } finally {
    git(top, ['worktree', 'remove', '--force', tree]);
    git(top, ['worktree', 'prune']);
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface TreeContext {
  opts: RewindOptions;
  deps: RewindDeps;
  runs: RunRecord[];
  run: RunRecord;
  test: TestResultRecord;
  tree: string;
  scratch: string;
  top: string;
}

async function replayInTree(ctx: TreeContext): Promise<RewindReport> {
  const { opts, deps, run, test, tree } = ctx;
  const pkgDir = packageDir(tree, test.test_file!);
  const installFailed = await install(pkgDir, deps);
  const toPkg = (f: string): string => relative(pkgDir, join(tree, f));
  const command = replayCommand({
    runner: run.reporter_format as ReplayRunner,
    file: toPkg(test.test_file!),
    testName: test.test_name,
    seed: def(run.replay?.seed, null),
    predecessors: opts.withPredecessors
      ? predecessors(run, test).map(toPkg)
      : [],
    reportPath: join(ctx.scratch, 'report.json'),
  });
  const attempts = installFailed === null ? opts.repeat : 0;
  const statuses = await runAttempts(ctx, command, pkgDir, attempts);
  const counted = countedAttempts(statuses);
  return {
    runId: run.run_id,
    test: test.test_name,
    commit: run.commit_sha!,
    fidelity: fidelityRows(run, test, {
      commitRestored: true,
      seedApplied: command.seedApplied,
      withPredecessors: opts.withPredecessors,
      host: deps.host,
      installFailed,
    }),
    attempts: opts.repeat,
    statuses,
    outcome: counted.length === 0 ? 'not-run' : classifyRepeats(counted),
    recorded: test,
    green: nearestGreen(ctx.runs, run, test.test_name, firstParent(ctx)),
  };
}

/** Run the command `attempts` times; each status read from a fresh report. */
async function runAttempts(
  ctx: TreeContext,
  command: ReplayCommand,
  pkgDir: string,
  attempts: number,
): Promise<string[]> {
  const reportPath = join(ctx.scratch, 'report.json');
  const runner = ctx.run.reporter_format as ReplayRunner;
  const statuses: string[] = [];
  for (let i = 0; i < attempts; i++) {
    rmSync(reportPath, { force: true });
    await ctx.deps.exec(command.command, command.args, {
      cwd: pkgDir,
      env: command.env,
    });
    const text = existsSync(reportPath)
      ? readFileSync(reportPath, 'utf-8')
      : '';
    const status = readReplayStatus(runner, text, ctx.test.test_name);
    if (status !== null) statuses.push(status);
  }
  return statuses;
}

/** `git rev-list --first-parent` from the failing commit, newest first. */
function firstParent(ctx: TreeContext): string[] {
  const args = ['rev-list', '--first-parent', '--max-count=1000'];
  return def(git(ctx.top, [...args, ctx.run.commit_sha!]), '').split('\n');
}

interface RewindCliOptions {
  test: string;
  repeat: number;
  withPredecessors?: boolean;
  path?: string;
  dbUrl?: string;
  json?: boolean;
}

function positiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new InvalidArgumentError(`--repeat must be 1-20, got "${raw}"`);
  }
  return n;
}

export function buildRewindCommand(
  deps: MainDeps,
  seams: Partial<RewindDeps> = {},
): Command {
  return new Command('rewind')
    .description(
      'Rerun a failed test from run history at its recorded commit, and report what was restored.',
    )
    .argument('<run_id>', 'Run id from the history store.')
    .requiredOption('--test <name>', 'Exact test name that failed in the run.')
    .addOption(
      new Option(
        '--repeat <n>',
        'Attempts, to tell reproduced from intermittent.',
      )
        .default(3)
        .argParser(positiveInt),
    )
    .option(
      '--with-predecessors',
      'Also run the files that started before it in the recorded run.',
    )
    .option('--path <store>', 'Local history store to read.')
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action(async (runId: string, opts: RewindCliOptions) => {
      const store = makeStore(opts.dbUrl, opts.path);
      const wired: RewindDeps = {
        out: deps.out,
        err: deps.err,
        cwd: deps.cwd,
        host: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        readRuns: async () => (store.readAll ? store.readAll() : null),
        exec: spawnExec,
        ...seams,
      };
      const code = await runRewind(
        {
          runId,
          test: opts.test,
          repeat: opts.repeat,
          withPredecessors: opts.withPredecessors === true,
          json: opts.json === true,
        },
        wired,
      );
      if (code !== 0) throw new CliExitError(code);
    });
}
