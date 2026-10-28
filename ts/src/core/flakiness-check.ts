/**
 * ci-ready's flakiness check over a non-empty run history (#604, #1506).
 *
 * Split out of `ci-ready.ts` to keep that module under its file-length budget.
 * The window is per suite, newest first by timestamp (`suiteWindows`); one
 * suite renders exactly as the check always has, several name each suite's
 * denominator. The skip cases (no store, unreadable store, no runs) stay in
 * `ci-ready.ts`, which owns the store input. Pure: callers pass the runs in.
 */
import {
  flakeSignals,
  suiteWindows,
  type FlakeSignal,
  type SuiteWindow,
} from './flake-signals.js';
import {
  MIN_WINDOW_RUNS,
  NOT_MEASURABLE_NOTE,
  MEASURABILITY_UNKNOWN_NOTE,
  insufficientHistoryNote,
  measurabilityOf,
  type FlakyMeasurable,
} from '../util/flake-window.js';

/** The run fields the flakiness check reads. */
interface ScoredRun {
  suite?: string | null;
  timestamp?: string | null;
  reporter_format?: string | null;
  tests?: { test_name: string; status: string }[];
}

/**
 * The flakiness check. Structurally identical to `CiCheck` in `ci-ready.ts`,
 * and declared here rather than imported so the dependency runs one way only
 * (ci-ready -> flakiness-check), the same pattern as `inventory-checks.ts`.
 */
interface CiCheck {
  name: string;
  verdict: 'pass' | 'warn' | 'fail';
  reason: string;
  measure: CheckMeasure | null;
}

interface CheckMeasure {
  value: number;
  unit: 'ratio';
  denominator: number;
}

/** Matches `canary analyze flaky`'s defaults: a 30-run window, 10% flake rate. */
const FLAKY_WINDOW_RUNS = 30;
const FLAKY_FAIL_RATE = 0.1;

/**
 * The measurability suffix for a clean window (#604 G3/SC4).
 *
 * A zero from a vitest-only window is STRUCTURAL: the vitest reader never
 * writes the `flaky` status, so no retry flake could have been observed
 * whatever the suite did. An unstamped legacy window cannot rule the status
 * out either way, so it says UNKNOWN rather than claiming a measured zero.
 */
function measurabilitySuffix(measurable: FlakyMeasurable): string {
  if (measurable === 'no') return `; ${NOT_MEASURABLE_NOTE}`;
  if (measurable === 'unknown') return `; ${MEASURABILITY_UNKNOWN_NOTE}`;
  return '';
}

/** A clean window's 0 is a measurement only when a flake was observable. */
function cleanMeasure(window: ScoredRun[]): CheckMeasure | null {
  if (measurabilityOf(window) !== 'yes') return null;
  return { value: 0, unit: 'ratio', denominator: window.length };
}

/**
 * A window with no findings (#604 G2/SC1).
 *
 * Below {@link MIN_WINDOW_RUNS} this is an ABSTENTION, not a pass: "0 flaky
 * across 2 run(s)" was the false green this check shipped for months. Warn
 * rather than skip (Decision D6), so the check stays visible in the report.
 */
function scoreCleanWindow(window: ScoredRun[]): CiCheck {
  const name = 'flakiness';
  const runsRead = window.length;
  const windowNote = `(window ${FLAKY_WINDOW_RUNS})`;
  if (runsRead < MIN_WINDOW_RUNS) {
    return {
      name,
      verdict: 'warn',
      reason: `${insufficientHistoryNote(runsRead)} ${windowNote} \u{2014} no flake verdict`,
      measure: null,
    };
  }
  return {
    name,
    verdict: 'pass',
    reason:
      `0 flaky or alternating tests across ${runsRead} run(s) ${windowNote}` +
      measurabilitySuffix(measurabilityOf(window)),
    measure: cleanMeasure(window),
  };
}

/** Score flakiness over a NON-EMPTY run history. */
export function scoreFlakyRuns(runs: ScoredRun[]): CiCheck {
  const windows = suiteWindows(runs, FLAKY_WINDOW_RUNS);
  // One suite reads exactly as it always has; several name each denominator.
  return windows.length === 1
    ? scoreWindow(windows[0]!.runs)
    : scoreSuites(windows);
}

/** The worst of a set of signals; a tie keeps the first seen. */
function worstOf(
  signals: Iterable<[string, FlakeSignal]>,
): [string, FlakeSignal] {
  let worst: [string, FlakeSignal] = [
    '',
    { rate: 0, axis: 'retry-flake', denominator: 0 },
  ];
  for (const entry of signals) if (entry[1].rate > worst[1].rate) worst = entry;
  return worst;
}

function flakyCheck(
  count: number,
  across: string,
  [worstName, worst]: [string, FlakeSignal],
): CiCheck {
  const pct = Math.round(worst.rate * 100);
  return {
    name: 'flakiness',
    verdict: worst.rate >= FLAKY_FAIL_RATE ? 'fail' : 'warn',
    reason:
      `${count} flaky or alternating test(s) across ${across}; worst is ` +
      `${worstName} at ${pct}% on ${worst.axis}`,
    measure: {
      value: worst.rate,
      unit: 'ratio',
      denominator: worst.denominator,
    },
  };
}

/** A single suite's window -- the pre-#1506 output, byte for byte. */
function scoreWindow(window: ScoredRun[]): CiCheck {
  const signals = flakeSignals(window);
  if (signals.size === 0) return scoreCleanWindow(window);
  const across = `${window.length} run(s) (window ${FLAKY_WINDOW_RUNS})`;
  return flakyCheck(signals.size, across, worstOf(signals));
}

/**
 * Several suites (#1506): each test is scored over its own suite's window, and
 * the reason names every suite's denominator, so "across 30 run(s)" can no
 * longer pass for 30 runs of each test. A clean result passes only when EVERY
 * suite clears the sample floor -- one thin suite's zero is an abstention.
 */
function scoreSuites(windows: SuiteWindow<ScoredRun>[]): CiCheck {
  const across =
    windows.map((w) => `${w.suite}: ${w.runs.length} run(s)`).join(', ') +
    ` (window ${FLAKY_WINDOW_RUNS} per suite)`;
  const found: [string, FlakeSignal][] = [];
  for (const w of windows) {
    for (const [nm, sig] of flakeSignals(w.runs)) {
      found.push([`${nm} in ${w.suite}`, sig]);
    }
  }
  if (found.length > 0) return flakyCheck(found.length, across, worstOf(found));
  const thin = windows.filter((w) => w.runs.length < MIN_WINDOW_RUNS);
  if (thin.length > 0) {
    const notes = thin.map(
      (w) => `${w.suite}: ${insufficientHistoryNote(w.runs.length)}`,
    );
    return {
      name: 'flakiness',
      verdict: 'warn',
      reason: `${notes.join(', ')}; across ${across} \u{2014} no flake verdict`,
      measure: null,
    };
  }
  const all = windows.flatMap((w) => w.runs);
  return {
    name: 'flakiness',
    verdict: 'pass',
    reason:
      `0 flaky or alternating tests across ${across}` +
      measurabilitySuffix(measurabilityOf(all)),
    measure: cleanMeasure(all),
  };
}
