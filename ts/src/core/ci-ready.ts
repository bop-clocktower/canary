/**
 * Deterministic scoring for the canary-ci-ready skill's five checks.
 *
 * The skill describes five pass/warn/fail checks. Only one has a real producer
 * in canary today: flakiness, scored from the run-history store. The other four
 * name inputs nothing writes: there is no `canary coverage` command to produce
 * `.canary/test-inventory.json`, and the history store records no durations. A
 * check without its input reports `skip` and names what is missing. It never
 * passes, and the overall verdict never treats a skip as a pass.
 *
 * Pure: callers read files and pass the results in, which keeps every rule here
 * testable without a filesystem.
 */
import type { RunRecord } from '../history/record.js';

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
  runs: RunRecord[] | null;
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
function flakeRates(runs: RunRecord[]): Map<string, number> {
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
  runs: RunRecord[] | null,
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

function scoreRuntime(): CiCheck {
  return {
    name: 'suite-runtime',
    verdict: 'skip',
    reason:
      'the run-history store records no durations, so a p95 runtime cannot be computed',
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
    scoreRuntime(),
  ];
  return {
    verdict: readinessVerdict(checks),
    checked: checks.filter((c) => c.verdict !== 'skip').length,
    checks,
  };
}
