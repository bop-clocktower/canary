// tally -- the digest's metrics, each carrying its own denominator (#609).
//
// Pure: windowed runs and a ledger in, numbers out. Every metric has exactly
// one of two shapes, {value, denominator} or {abstained, reason}. There is no
// third shape, so no renderer can print a bare 0 whose denominator collapsed
// -- the "1 run, 0 escapes" digest that undersells QA (#508 D4, spec D4).

import { partitionByWindow } from './window.mjs';

/** Below this, one run is the whole story (spec D5). A constant, not a flag. */
export const THIN_SAMPLE_RUNS = 3;

/** Mirrors FLAKY_CAPABLE_FORMATS in ts/src/util/flake-window.ts (#604). */
export const FLAKY_CAPABLE_FORMATS = ['playwright', 'junit'];

export const PRODUCTION_ESCAPES_DARK =
  'production escapes: no canary store records them, so escapes avoided cannot be measured';

export function measured(value, denominator, reason) {
  return denominator === 0
    ? { abstained: true, reason }
    : { value, denominator };
}

const testsOf = (run) => (Array.isArray(run.tests) ? run.tests : []);

function distinctWithStatus(runs, status) {
  const names = new Set();
  for (const run of runs) {
    for (const test of testsOf(run)) {
      if (test.status === status) names.add(test.test_name);
    }
  }
  return names.size;
}

function sampleOf(runs) {
  const dayOf = (r) => new Date(r.timestamp).toISOString().slice(0, 10);
  return {
    runs: runs.length,
    suites: new Set(runs.map((r) => r.suite)).size,
    days: new Set(runs.map(dayOf)).size,
  };
}

function executedCount(run) {
  return Array.isArray(run.tests) ? run.tests.length : Number(run.total ?? 0);
}

// D7: "caught before <branch>" is a factual proxy (failures seen on other
// branches), never a claim that a bug was prevented. A run with no branch is
// provably neither, so it is counted in neither and surfaced as a note.
function branchMetrics(runs, branch) {
  const other = runs.filter((r) => Boolean(r.branch) && r.branch !== branch);
  const onBranch = runs.filter((r) => r.branch === branch);
  return {
    preMerge: measured(
      distinctWithStatus(other, 'failed'),
      other.length,
      `no runs on branches other than ${branch} in the window`,
    ),
    reached: measured(
      distinctWithStatus(onBranch, 'failed'),
      onBranch.length,
      `no runs on ${branch} in the window`,
    ),
    unbranched: runs.length - other.length - onBranch.length,
  };
}

// D8: a vitest run cannot emit `flaky`, so its zero is structural, not
// measured. Only flaky-capable runs are in the denominator.
function flakySurfaced(runs) {
  const capable = runs.filter((r) =>
    FLAKY_CAPABLE_FORMATS.includes(r.reporter_format),
  );
  return measured(
    distinctWithStatus(capable, 'flaky'),
    capable.length,
    `no run in the window came from a reporter that can emit flaky (${FLAKY_CAPABLE_FORMATS.join(', ')})`,
  );
}

/** A Map, not an object: a ledger `kind` of "constructor" must count as 1. */
function countBy(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row[field] || 'unrecorded');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

function quarantineTrail(ledger, window) {
  if (ledger.state === 'dark') {
    return { abstained: true, reason: ledger.reason };
  }
  if (ledger.rows.length === 0) {
    return {
      abstained: true,
      reason: 'the quarantine ledger holds no entries',
    };
  }
  const { inside, undated } = partitionByWindow(
    ledger.rows,
    (r) => r.date,
    window,
  );
  return {
    value: inside.length,
    denominator: ledger.rows.length,
    undated,
    byKind: countBy(inside, 'kind'),
    byCause: countBy(inside, 'cause'),
  };
}

function darkSources(quarantine) {
  const ledger = quarantine.abstained
    ? [`quarantine ledger: ${quarantine.reason}`]
    : [];
  return [...ledger, PRODUCTION_ESCAPES_DARK];
}

function stateFor(runCount) {
  if (runCount === 0) return 'abstained';
  return runCount < THIN_SAMPLE_RUNS ? 'thin' : 'ok';
}

/**
 * @param {{runs: object[], ledger: {state: string, rows: object[], reason: string|null},
 *          branch: string, window: {since: Date, until: Date}}} input
 */
export function tallyDigest({ runs, ledger, branch, window }) {
  const { inside, undated } = partitionByWindow(
    runs,
    (r) => r.timestamp,
    window,
  );
  const quarantine = quarantineTrail(ledger, window);
  const executed = inside.reduce((n, r) => n + executedCount(r), 0);
  return {
    state: stateFor(inside.length),
    branch,
    window,
    sample: sampleOf(inside),
    undatedRuns: undated,
    tests: measured(executed, inside.length, 'no runs in the window'),
    ...branchMetrics(inside, branch),
    flaky: flakySurfaced(inside),
    quarantine,
    dark: darkSources(quarantine),
  };
}
