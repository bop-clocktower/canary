/**
 * Deterministic scoring for the canary-ci-ready skill's five checks.
 *
 * The skill describes five pass/warn/fail checks. Flakiness and suite runtime
 * are scored from the run-history store (suite runtime is the p95 of recorded
 * run `duration_ms`, which `canary history record` writes since #956);
 * coverage-depth, assertion-quality and critical-paths from
 * `.canary/test-inventory.json`, which `canary inventory` writes (#957; scoring
 * in `inventory-checks.ts`). A check without its input -- including suite
 * runtime over legacy runs that carry no duration -- reports `skip` and names
 * what is missing. It never passes, and the overall verdict never treats a skip
 * as a pass.
 *
 * Suite runtime is scored against the SKILL's absolute-threshold fallback
 * (5 / 10 minutes), not a perf baseline; the reason says so.
 *
 * Pure: callers read files and pass the results in, which keeps every rule here
 * testable without a filesystem.
 */
import {
  scoreInventoryChecks,
  type CriticalAreasInput,
  type InventoryInput,
} from './inventory-checks.js';
import { flakeSignals, type FlakeSignal } from './flake-signals.js';
import {
  MIN_WINDOW_RUNS,
  NOT_MEASURABLE_NOTE,
  MEASURABILITY_UNKNOWN_NOTE,
  insufficientHistoryNote,
  measurabilityOf,
  type FlakyMeasurable,
} from '../util/flake-window.js';

interface ScoredRun {
  duration_ms?: number | null;
  /** Which reader produced the run (#604); absent on legacy rows. */
  reporter_format?: string | null;
  tests?: { test_name: string; status: string }[];
}

export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'skip';
export type ReadinessVerdict =
  'ready' | 'incomplete' | 'not-ready' | 'abstained';

/**
 * The number a check scored, in a form a feed can carry without parsing the
 * prose `reason` (#1151 phase 2, P1). `null` when the check measured
 * nothing: a skip, a window too thin to judge, or a zero the reader could
 * not have observed. Null is never 0.
 */
export interface CheckMeasure {
  value: number;
  unit: 'ratio' | 'count' | 'ms';
  denominator: number;
}

export interface CiCheck {
  name: string;
  verdict: CheckVerdict;
  reason: string;
  measure: CheckMeasure | null;
}

export interface CiReadyReport {
  verdict: ReadinessVerdict;
  /** Checks that actually scored something. Skipped checks do NOT count. */
  checked: number;
  checks: CiCheck[];
}

/**
 * The run-history store as ci-ready sees it: the stored runs, null when the
 * file does not exist, or the reason a store that EXISTS cannot be read
 * (EISDIR, EACCES, ...; #1132). Unreadable is not absent -- both history
 * checks skip naming the reason, never "no runs recorded".
 */
export type RunsInput = ScoredRun[] | null | { ok: false; reason: string };

export interface CiReadyInputs {
  runs: RunsInput;
  historyPath: string;
  /** Parsed `.canary/test-inventory.json`, or the reason it cannot be scored. */
  inventory: InventoryInput;
  /** Parsed `.canary/critical-areas.json`, or the reason it is unusable. */
  criticalAreas: CriticalAreasInput;
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

/** The skip for a store that exists but cannot be read, or null. */
function unreadableSkip(name: string, runs: RunsInput): CiCheck | null {
  if (runs === null || Array.isArray(runs)) return null;
  return { name, verdict: 'skip', reason: runs.reason, measure: null };
}

function scoreFlakiness(runs: RunsInput, historyPath: string): CiCheck {
  const name = 'flakiness';
  const unreadable = unreadableSkip(name, runs);
  if (unreadable) return unreadable;
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      name,
      verdict: 'skip',
      reason: `no runs recorded in ${historyPath}`,
      measure: null,
    };
  }
  const window = runs.slice(-FLAKY_WINDOW_RUNS);
  const signals = flakeSignals(window);
  if (signals.size === 0) return scoreCleanWindow(window);
  let worstName = '';
  let worst: FlakeSignal = { rate: 0, axis: 'retry-flake', denominator: 0 };
  for (const [nm, sig] of signals) {
    if (sig.rate > worst.rate) {
      worst = sig;
      worstName = nm;
    }
  }
  const pct = Math.round(worst.rate * 100);
  const verdict: CheckVerdict = worst.rate >= FLAKY_FAIL_RATE ? 'fail' : 'warn';
  return {
    name,
    verdict,
    reason:
      `${signals.size} flaky or alternating test(s) across ${window.length} ` +
      `run(s) (window ${FLAKY_WINDOW_RUNS}); worst is ${worstName} at ` +
      `${pct}% on ${worst.axis}`,
    measure: {
      value: worst.rate,
      unit: 'ratio',
      denominator: worst.denominator,
    },
  };
}

/**
 * 30 runs, but counted among runs that CARRY a duration, so the window can
 * reach further back than flakiness's. Thresholds from the SKILL's fallback.
 */
const RUNTIME_WINDOW_RUNS = 30;
const RUNTIME_WARN_MS = 5 * 60_000;
const RUNTIME_FAIL_MS = 10 * 60_000;

/** Nearest-rank percentile of a non-empty list. */
function nearestRank(values: number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1]!;
}

function humanDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function runtimeVerdict(p95: number): CheckVerdict {
  if (p95 > RUNTIME_FAIL_MS) return 'fail';
  return p95 >= RUNTIME_WARN_MS ? 'warn' : 'pass';
}

function scoreRuntime(runs: RunsInput, historyPath: string): CiCheck {
  const name = 'suite-runtime';
  const unreadable = unreadableSkip(name, runs);
  if (unreadable) return unreadable;
  const durations = (Array.isArray(runs) ? runs : [])
    .map((r) => r.duration_ms)
    .filter((d): d is number => typeof d === 'number' && d > 0 && isFinite(d))
    .slice(-RUNTIME_WINDOW_RUNS);
  if (durations.length === 0) {
    return {
      name,
      verdict: 'skip',
      reason: `no run in ${historyPath} carries a duration_ms, so a p95 runtime cannot be computed`,
      measure: null,
    };
  }
  const p95 = nearestRank(durations, 95);
  return {
    name,
    verdict: runtimeVerdict(p95),
    reason: `p95 ${humanDuration(p95)} across ${durations.length} run(s) vs. absolute threshold (warn at 5m, fail over 10m)`,
    measure: null,
  };
}

function readinessVerdict(checks: CiCheck[]): ReadinessVerdict {
  const scored = checks.filter((c) => c.verdict !== 'skip');
  if (scored.length === 0) return 'abstained';
  if (scored.some((c) => c.verdict === 'fail')) return 'not-ready';
  if (
    scored.length === checks.length &&
    scored.every((c) => c.verdict === 'pass')
  ) {
    return 'ready';
  }
  return 'incomplete';
}

export function scoreCiReady(inputs: CiReadyInputs): CiReadyReport {
  const [coverage, assertions, criticalPaths] = scoreInventoryChecks(
    inputs.inventory,
    inputs.criticalAreas,
  );
  const checks: CiCheck[] = [
    coverage!,
    scoreFlakiness(inputs.runs, inputs.historyPath),
    assertions!,
    criticalPaths!,
    scoreRuntime(inputs.runs, inputs.historyPath),
  ];
  return {
    verdict: readinessVerdict(checks),
    checked: checks.filter((c) => c.verdict !== 'skip').length,
    checks,
  };
}
