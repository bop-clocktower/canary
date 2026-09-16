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
  const flipRate = alternationRate(detectAlternation(tally.statuses));
  if (flakeRate <= 0 && flipRate <= 0) return null;
  return flipRate > flakeRate
    ? { rate: flipRate, axis: 'cross-run flips' }
    : { rate: flakeRate, axis: 'retry-flake' };
}

/**
 * A flip rate of 0 unless the alternation floor is cleared: one flip is a step
 * change, and reporting it as a flake to retry would bury every genuine
 * regression (Decision D3).
 */
function alternationRate(alt: AlternationResult): number {
  return isAlternating(alt, 0) ? alt.flip_rate_pct / 100 : 0;
}
