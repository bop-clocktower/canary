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

// A run whose `tests` is not an array carries counts only (legacy or
// count-only writers). It cannot say WHICH test failed, so it is kept out of
// every per-test denominator -- counting it there would print a measured zero
// over a run that never itemised anything. It is surfaced as a sample note.
const itemized = (run) => Array.isArray(run.tests);

/** One identity per test: equal names in different suites/files are distinct. */
const testKey = (run, test) =>
  [test.suite ?? run.suite ?? '', test.test_file ?? '', test.test_name].join(
    '\u0000',
  );

function distinctWithStatus(runs, status) {
  const keys = new Set();
  for (const run of runs.filter(itemized)) {
    for (const test of run.tests) {
      if (test.status === status) keys.add(testKey(run, test));
    }
  }
  return keys.size;
}

function sampleOf(runs) {
  const dayOf = (r) => new Date(r.timestamp).toISOString().slice(0, 10);
  return {
    runs: runs.length,
    suites: new Set(runs.map((r) => r.suite)).size,
    days: new Set(runs.map(dayOf)).size,
  };
}

/** Runs that report a test count at all: itemised, or a numeric `total`. */
const counted = (run) => itemized(run) || Number.isFinite(run.total);

function testsExecuted(runs) {
  const withCount = runs.filter(counted);
  const value = withCount.reduce(
    (n, r) => n + (itemized(r) ? r.tests.length : r.total),
    0,
  );
  return measured(
    value,
    withCount.length,
    'no run in the window reports a test count',
  );
}

// D7: "caught before <branch>" is a factual proxy (failures seen on other
// branches), never a claim that a bug was prevented. A run with no branch is
// provably neither, so it is counted in neither and surfaced as a note.
function branchMetrics(runs, branch) {
  const other = runs.filter((r) => Boolean(r.branch) && r.branch !== branch);
  const onBranch = runs.filter((r) => r.branch === branch);
  const itemizedOther = other.filter(itemized);
  const itemizedOn = onBranch.filter(itemized);
  return {
    preMerge: measured(
      distinctWithStatus(itemizedOther, 'failed'),
      itemizedOther.length,
      `no per-test results from branches other than ${branch} in the window`,
    ),
    reached: measured(
      distinctWithStatus(itemizedOn, 'failed'),
      itemizedOn.length,
      `no per-test results from ${branch} in the window`,
    ),
    unbranched: runs.length - other.length - onBranch.length,
  };
}

// D8: a vitest run cannot emit `flaky`, so its zero is structural, not
// measured. Only flaky-capable runs are in the denominator.
// A run with no `reporter_format` stamp is UNKNOWN capability, not "cannot":
// the reason says which, so a reader knows whether to fix the writer or the
// reporter (flake-window.ts draws the same line).
function flakyReason(runs) {
  const stamped = runs.some((r) => typeof r.reporter_format === 'string');
  return stamped
    ? `no run in the window came from a reporter that can emit flaky (${FLAKY_CAPABLE_FORMATS.join(', ')})`
    : 'no run in the window records its reporter_format, so whether flaky could be emitted is unknown';
}

function flakySurfaced(runs) {
  const capable = runs.filter(
    (r) => itemized(r) && FLAKY_CAPABLE_FORMATS.includes(r.reporter_format),
  );
  return measured(
    distinctWithStatus(capable, 'flaky'),
    capable.length,
    flakyReason(runs),
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
  return {
    state: stateFor(inside.length),
    branch,
    window,
    sample: sampleOf(inside),
    undatedRuns: undated,
    unitemizedRuns: inside.filter((r) => !itemized(r)).length,
    tests: testsExecuted(inside),
    ...branchMetrics(inside, branch),
    flaky: flakySurfaced(inside),
    quarantine,
    dark: darkSources(quarantine),
  };
}
