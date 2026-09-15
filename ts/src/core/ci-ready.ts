/**
 * Deterministic scoring for the canary-ci-ready skill's five checks.
 *
 * The skill describes five pass/warn/fail checks. Two have a real producer in
 * canary today, both scored from the run-history store: flakiness, and suite
 * runtime (p95 of recorded run `duration_ms`, which `canary history record`
 * writes since #956). The other three need `.canary/test-inventory.json`, and
 * there is no `canary coverage` command to produce it. A check without its
 * input -- including suite runtime over legacy runs that carry no duration --
 * reports `skip` and names what is missing. It never passes, and the overall
 * verdict never treats a skip as a pass.
 *
 * Suite runtime is scored against the SKILL's absolute-threshold fallback
 * (5 / 10 minutes), not a perf baseline; the reason says so.
 *
 * Pure: callers read files and pass the results in, which keeps every rule here
 * testable without a filesystem.
 */
interface ScoredRun {
  duration_ms?: number | null;
  tests?: { test_name: string; status: string }[];
}

export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'skip';
export type ReadinessVerdict =
  'ready' | 'incomplete' | 'not-ready' | 'abstained';

export interface CiCheck {
  name: string;
  verdict: CheckVerdict;
  reason: string;
}

export interface CiReadyReport {
  verdict: ReadinessVerdict;
  /** Checks that actually scored something. Skipped checks do NOT count. */
  checked: number;
  checks: CiCheck[];
}

export interface CiReadyInputs {
  /** Stored runs, or null when the history file does not exist. */
  runs: ScoredRun[] | null;
  historyPath: string;
  hasInventory: boolean;
  hasCriticalAreas: boolean;
}

/** Matches `canary analyze flaky`'s defaults: a 30-run window, 10% flake rate. */
const FLAKY_WINDOW_RUNS = 30;
const FLAKY_FAIL_RATE = 0.1;

const INVENTORY = '.canary/test-inventory.json';
const CRITICAL_AREAS = '.canary/critical-areas.json';

function inventoryMissingReason(): string {
  return `no ${INVENTORY}: nothing in canary produces it (the documented \`canary coverage\` command does not exist)`;
}

/** Per-test flake rate across the window, for tests that appeared at all. */
function flakeRates(runs: ScoredRun[]): Map<string, number> {
  const seen = new Map<string, { present: number; flaky: number }>();
  for (const run of runs) {
    for (const t of run.tests ?? []) {
      const s = seen.get(t.test_name) ?? { present: 0, flaky: 0 };
      s.present += 1;
      if (t.status === 'flaky') s.flaky += 1;
      seen.set(t.test_name, s);
    }
  }
  const rates = new Map<string, number>();
  for (const [name, s] of seen) {
    if (s.flaky > 0) rates.set(name, s.flaky / s.present);
  }
  return rates;
}

function scoreFlakiness(
  runs: ScoredRun[] | null,
  historyPath: string,
): CiCheck {
  const name = 'flakiness';
  if (runs === null || runs.length === 0) {
    return {
      name,
      verdict: 'skip',
      reason: `no runs recorded in ${historyPath}`,
    };
  }
  const window = runs.slice(-FLAKY_WINDOW_RUNS);
  const rates = flakeRates(window);
  if (rates.size === 0) {
    return {
      name,
      verdict: 'pass',
      reason: `0 flaky tests across ${window.length} run(s)`,
    };
  }
  let worst: [string, number] = ['', 0];
  for (const entry of rates) if (entry[1] > worst[1]) worst = entry;
  const pct = Math.round(worst[1] * 100);
  const verdict: CheckVerdict = worst[1] >= FLAKY_FAIL_RATE ? 'fail' : 'warn';
  return {
    name,
    verdict,
    reason: `${rates.size} flaky test(s) across ${window.length} run(s); worst is ${worst[0]} at ${pct}%`,
  };
}

function scoreInventoryCheck(name: string, hasInventory: boolean): CiCheck {
  const reason = hasInventory
    ? `${INVENTORY} is present, but no documented schema exists to score it against`
    : inventoryMissingReason();
  return { name, verdict: 'skip', reason };
}

function scoreCriticalPaths(
  hasCriticalAreas: boolean,
  hasInventory: boolean,
): CiCheck {
  const name = 'critical-paths';
  if (!hasCriticalAreas) {
    return {
      name,
      verdict: 'skip',
      reason: `no ${CRITICAL_AREAS}, and cross-referencing it also needs ${INVENTORY}`,
    };
  }
  return {
    name,
    verdict: 'skip',
    reason: scoreInventoryCheck(name, hasInventory).reason,
  };
}

/** Same 30-run window as flakiness; thresholds from the SKILL's fallback. */
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

function scoreRuntime(runs: ScoredRun[] | null, historyPath: string): CiCheck {
  const name = 'suite-runtime';
  const durations = (runs ?? [])
    .map((r) => r.duration_ms)
    .filter((d): d is number => typeof d === 'number' && d > 0 && isFinite(d))
    .slice(-RUNTIME_WINDOW_RUNS);
  if (durations.length === 0) {
    return {
      name,
      verdict: 'skip',
      reason: `no run in ${historyPath} carries a duration_ms, so a p95 runtime cannot be computed`,
    };
  }
  const p95 = nearestRank(durations, 95);
  return {
    name,
    verdict: runtimeVerdict(p95),
    reason: `p95 ${humanDuration(p95)} across ${durations.length} run(s) vs. absolute threshold (warn at 5m, fail over 10m)`,
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
  const checks: CiCheck[] = [
    scoreInventoryCheck('coverage-depth', inputs.hasInventory),
    scoreFlakiness(inputs.runs, inputs.historyPath),
    scoreInventoryCheck('assertion-quality', inputs.hasInventory),
    scoreCriticalPaths(inputs.hasCriticalAreas, inputs.hasInventory),
    scoreRuntime(inputs.runs, inputs.historyPath),
  ];
  return {
    verdict: readinessVerdict(checks),
    checked: checks.filter((c) => c.verdict !== 'skip').length,
    checks,
  };
}
