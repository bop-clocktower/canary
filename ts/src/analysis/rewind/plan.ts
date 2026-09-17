/**
 * `canary rewind`, the deterministic half (#461 PR 2, proposal criteria 3-8).
 *
 * Everything here is pure: given the stored runs and what the replay managed
 * to restore, it decides what may be claimed. The defining rule is the
 * issue's: **never silently approximate.** Each dimension of the original run
 * is reported as `restored`, `not-restored` (with the reason) or
 * `not-recorded` (the record never held it), and nothing is `restored` unless
 * the replay actually put it back.
 */

import type { ReplayContext } from '../../history/keys/replay-record.js';
import type { RunRecord, TestResultRecord } from '../../history/record.js';

export const DIMENSIONS = [
  'commit',
  'seed',
  'order',
  'environment',
  'network',
  'database',
  'wall-clock',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type FidelityStatus = 'restored' | 'not-restored' | 'not-recorded';

export interface FidelityRow {
  dimension: Dimension;
  status: FidelityStatus;
  reason: string;
}

/** Runners `rewind` knows how to invoke for a single test. */
export const REPLAYABLE_RUNNERS = ['vitest', 'playwright'] as const;

export type Located =
  | { ok: true; run: RunRecord; test: TestResultRecord }
  | { ok: false; reason: string };

const FAILING = new Set(['failed', 'flaky']);

/** Find the named failed test, or the reason a replay must abstain. */
export function locateFailure(
  runs: RunRecord[],
  runId: string,
  testName: string,
): Located {
  const run = runs.find((r) => r.run_id === runId);
  if (!run) return { ok: false, reason: `run '${runId}' is not in the store` };
  const test = (run.tests ?? []).find((t) => t.test_name === testName);
  if (!test) {
    return { ok: false, reason: `no test named '${testName}' in run ${runId}` };
  }
  if (!FAILING.has(test.status)) {
    return {
      ok: false,
      reason: `'${testName}' did not fail in run ${runId} (${test.status})`,
    };
  }
  return replayable(run, test);
}

/**
 * Why a stored `test_file` cannot name a file at the old commit, or null.
 * Absolute paths predate #1021; a `..` segment would leave the worktree.
 */
export function testFileProblem(file: string | undefined): string | null {
  const f = file ?? '';
  if (f === '' || f.startsWith('/') || /^[A-Za-z]:/.test(f)) {
    return `test_file '${f}' is not repo-relative (recorded before #1021), so it names no file at the old commit`;
  }
  return f.split(/[\\/]/).includes('..')
    ? `test_file '${f}' points outside the repository`
    : null;
}

function replayable(run: RunRecord, test: TestResultRecord): Located {
  const sha = run.commit_sha ?? 'local';
  if (sha === 'local') {
    return {
      ok: false,
      reason: `run ${run.run_id} was recorded against commit 'local', which names no commit`,
    };
  }
  const runner = run.reporter_format ?? 'unknown';
  if (!(REPLAYABLE_RUNNERS as readonly string[]).includes(runner)) {
    return {
      ok: false,
      reason: `no replay command for '${runner}' reports (supported: ${REPLAYABLE_RUNNERS.join(', ')})`,
    };
  }
  return { ok: true, run, test };
}

export interface HostFingerprint {
  node: string;
  os: string;
  arch: string;
}

export interface ReplayFacts {
  commitRestored: boolean;
  /** The recorded seed was passed to the runner. */
  seedApplied: boolean;
  withPredecessors: boolean;
  host: HostFingerprint;
  /** Why installing dependencies at the old commit failed, else null. */
  installFailed: string | null;
}

/** The per-dimension table (criteria 3, 5, 6). */
export function fidelityRows(
  run: RunRecord,
  test: TestResultRecord,
  facts: ReplayFacts,
): FidelityRow[] {
  const always = (dimension: Dimension): FidelityRow => ({
    dimension,
    status: 'not-restored',
    reason: 'never captured; replays run against live state',
  });
  return [
    commitRow(run, facts),
    seedRow(run.replay, facts),
    orderRow(test, facts),
    environmentRow(run.replay, facts),
    always('network'),
    always('database'),
    always('wall-clock'),
  ];
}

function commitRow(run: RunRecord, facts: ReplayFacts): FidelityRow {
  const sha = (run.commit_sha ?? '').slice(0, 12);
  return facts.commitRestored
    ? { dimension: 'commit', status: 'restored', reason: `checked out ${sha}` }
    : {
        dimension: 'commit',
        status: 'not-restored',
        reason: `${sha} unreachable`,
      };
}

function seedRow(
  replay: ReplayContext | undefined,
  facts: ReplayFacts,
): FidelityRow {
  if (!replay || replay.seed === null) {
    return {
      dimension: 'seed',
      status: 'not-recorded',
      reason: 'no seed recorded',
    };
  }
  return facts.seedApplied
    ? { dimension: 'seed', status: 'restored', reason: `seed ${replay.seed}` }
    : {
        dimension: 'seed',
        status: 'not-restored',
        reason: `seed ${replay.seed} recorded, but the runner takes no seed option`,
      };
}

/**
 * Never `restored`: even with predecessor files the runner, not canary,
 * decides execution order, so claiming the original order would be a guess.
 */
function orderRow(test: TestResultRecord, facts: ReplayFacts): FidelityRow {
  if (test.start_index === undefined) {
    return {
      dimension: 'order',
      status: 'not-recorded',
      reason: 'no file start order recorded',
    };
  }
  const reason = facts.withPredecessors
    ? 'earlier files ran first, but the runner decides their order'
    : 'ran its own file only; pass --with-predecessors to include earlier files';
  return { dimension: 'order', status: 'not-restored', reason };
}

function environmentRow(
  replay: ReplayContext | undefined,
  facts: ReplayFacts,
): FidelityRow {
  if (!replay) {
    return {
      dimension: 'environment',
      status: 'not-recorded',
      reason: 'no fingerprint recorded',
    };
  }
  if (facts.installFailed !== null) {
    return {
      dimension: 'environment',
      status: 'not-restored',
      reason: `dependency install failed: ${facts.installFailed}`,
    };
  }
  const keys = ['node', 'os', 'arch'] as const;
  const differing = keys
    .filter((k) => replay[k] !== facts.host[k])
    .map((k) => `${k} ${replay[k]} -> ${facts.host[k]}`);
  return differing.length === 0
    ? {
        dimension: 'environment',
        status: 'restored',
        reason: 'node, os and arch match',
      }
    : {
        dimension: 'environment',
        status: 'not-restored',
        reason: differing.join('; '),
      };
}

export type ReplayOutcome = 'reproduced' | 'not-reproduced' | 'intermittent';

/** Attempts that actually ran the test: skipped/pending ones say nothing. */
export function countedAttempts(statuses: string[]): string[] {
  return statuses.filter((s) => s === 'passed' || FAILING.has(s));
}

/** Criterion 8: all failing, none failing, or some of each. */
export function classifyRepeats(statuses: string[]): ReplayOutcome {
  const failures = statuses.filter((s) => FAILING.has(s)).length;
  if (failures === statuses.length) return 'reproduced';
  return failures === 0 ? 'not-reproduced' : 'intermittent';
}

/**
 * Criterion 7 / F5: the same suite's run at the fewest first-parent commits
 * back from the failing SHA in which this test passed. `firstParent` is
 * `git rev-list --first-parent <failing sha>`, newest first.
 */
export function nearestGreen(
  runs: RunRecord[],
  failing: RunRecord,
  testName: string,
  firstParent: string[],
): { run: RunRecord; distance: number } | null {
  const distance = new Map(firstParent.map((sha, i) => [sha, i]));
  let best: { run: RunRecord; distance: number } | null = null;
  for (const r of runs) {
    const d = distance.get(r.commit_sha ?? '');
    if (d === undefined || r.suite !== failing.suite || r === failing) continue;
    if (!passed(r, testName)) continue;
    if (best === null || d < best.distance) best = { run: r, distance: d };
  }
  return best;
}

function passed(run: RunRecord, testName: string): boolean {
  return (run.tests ?? []).some(
    (t) => t.test_name === testName && t.status === 'passed',
  );
}
