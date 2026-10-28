/**
 * The two-axis flake signal `ci-ready`'s flakiness check scores (#604).
 *
 * Split out of `ci-ready.ts` to keep that module under its file-length budget.
 * The flip half comes from the shared `util/alternation` leaf, the same
 * computation `history/ndjson-store.queryFlaky` uses, so the check and the
 * `flaky` commands cannot drift about what counts as a flip. Pure: callers
 * pass the runs in.
 */

import {
  detectAlternation,
  isAlternating,
  type AlternationResult,
} from '../util/alternation.js';

/** The run fields this module reads. */
interface SignalRun {
  tests?: { test_name: string; status: string }[];
}

/** One test's worst flake signal, and which axis produced it. */
export interface FlakeSignal {
  /** 0-1. `max(flake_rate, flip_rate)` -- Decision D4/D9. */
  rate: number;
  /** `retry-flake` or `cross-run flips`, so the reason names the axis. */
  axis: string;
  /**
   * What `rate` was divided by (#1151 phase 2): the test's own appearances for
   * `retry-flake`, its definitive-outcome transitions for `cross-run flips`.
   * Never the window length -- a test absent from some runs was not measured
   * in them.
   */
  denominator: number;
}

/**
 * Per-test flake signal across the window, on BOTH axes (#604 Phase 2).
 *
 * The retry-flake rate alone is structurally blind to the population #604 was
 * filed for: `flaky` is a within-run retry, and the vitest reader never writes
 * it, so a test alternating passed/failed across runs scored 0 here. The flip
 * axis is computed from the same ordered sequence
 * `history/ndjson-store.queryFlaky` builds, through the shared
 * `util/alternation` leaf, so the check and the commands cannot drift.
 *
 * Only tests with a signal on some axis are returned; the flip axis has to
 * clear {@link isAlternating}'s floor before it counts, so a single step
 * change stays `detectRegressions`' business.
 */
export function flakeSignals(runs: SignalRun[]): Map<string, FlakeSignal> {
  const signals = new Map<string, FlakeSignal>();
  for (const [name, tally] of tallyTests(runs)) {
    const signal = worstAxis(tally);
    if (signal) signals.set(name, signal);
  }
  return signals;
}

/** Per-test appearances, retry flakes, and the ordered status sequence. */
interface TestTally {
  present: number;
  flaky: number;
  statuses: string[];
}

function tallyTests(runs: SignalRun[]): Map<string, TestTally> {
  const seen = new Map<string, TestTally>();
  for (const run of runs) {
    for (const t of run.tests ?? []) {
      const s = seen.get(t.test_name) ?? { present: 0, flaky: 0, statuses: [] };
      s.present += 1;
      if (t.status === 'flaky') s.flaky += 1;
      s.statuses.push(t.status);
      seen.set(t.test_name, s);
    }
  }
  return seen;
}

/** The worse of the two axes, or `null` when neither fired. */
function worstAxis(tally: TestTally): FlakeSignal | null {
  const flakeRate = tally.present > 0 ? tally.flaky / tally.present : 0;
  const alt = detectAlternation(tally.statuses);
  const flipRate = alternationRate(alt);
  if (flakeRate <= 0 && flipRate <= 0) return null;
  // `flip_rate_pct` is flips over `observed - 1` transitions (util/alternation).
  return flipRate > flakeRate
    ? { rate: flipRate, axis: 'cross-run flips', denominator: alt.observed - 1 }
    : { rate: flakeRate, axis: 'retry-flake', denominator: tally.present };
}

/**
 * A flip rate of 0 unless the alternation floor is cleared: one flip is a step
 * change, and reporting it as a flake to retry would bury every genuine
 * regression (Decision D3).
 */
function alternationRate(alt: AlternationResult): number {
  return isAlternating(alt, 0) ? alt.flip_rate_pct / 100 : 0;
}

/** The run fields {@link suiteWindows} reads to group and order runs. */
interface WindowedRun {
  suite?: string | null;
  timestamp?: string | null;
}

/** One suite's flake window: its label and its newest runs, oldest first. */
export interface SuiteWindow<R> {
  suite: string;
  runs: R[];
}

/** The label a run without a `suite` is grouped under. */
const NO_SUITE = '(no suite)';

/**
 * Split runs into per-suite windows of each suite's newest `size` runs (#1506).
 *
 * File order is APPEND order, not time: a history built by concatenating
 * per-suite files holds one suite's runs and then the next's, so the file's
 * last N lines are one suite's tail. Each suite therefore gets its own window,
 * ordered by `timestamp` the way `history/ndjson-store.queryFlaky` orders its
 * window (a stable sort with absent timestamps as '', so untimestamped runs
 * sort oldest and keep their append order among themselves). Suites come back
 * sorted by label, so the result
 * does not depend on file order either.
 *
 * Within a suite, tests are still keyed by `test_name` alone -- the identity
 * `queryFlaky` uses (see #1350); this does not change it.
 *
 * The one place a window is chosen: a filter on which runs or tests count
 * (e.g. retired tests, #1500) belongs here.
 */
export function suiteWindows<R extends WindowedRun>(
  runs: readonly R[],
  size: number,
): SuiteWindow<R>[] {
  const bySuite = new Map<string, R[]>();
  for (const run of runs) {
    const suite = run.suite ?? NO_SUITE;
    const list = bySuite.get(suite) ?? [];
    list.push(run);
    bySuite.set(suite, list);
  }
  const ts = (r: R): string => r.timestamp ?? '';
  return [...bySuite.keys()].sort(byString).map((suite) => ({
    suite,
    runs: [...bySuite.get(suite)!]
      .sort((a, b) => byString(ts(a), ts(b)))
      .slice(-size),
  }));
}

function byString(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
