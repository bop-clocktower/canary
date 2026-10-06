// model -- the pure rules every site-kit panel shares (#1151 phase 3).
//
// No DOM here: panel.js renders, this file decides. The rules that make a
// number honest live in one place, tested without a browser: null is not 0
// (D4), a pass rate never rounds up to 100%, a suite with no recent run is
// dark (D15), and a sharded run counts once.
//
// The kit is copied verbatim into a built site, so it cannot import the
// node-side skill scripts. The shard rule below mirrors canary-starling's
// runs.mjs logicalId (#1148) on purpose.

/** D15: a suite with no run inside this many days is dark. Defined once. */
export const DARK_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

/** What a panel renders for a value it could not measure (D4). */
export const ABSENT = '—';

export const scopeLabel = (scope) => `${scope.id}/${scope.env}`;
export const suiteKey = (scope, suite) =>
  `${scope.id}\u0000${scope.env}\u0000${suite}`;

const logicalId = (r) =>
  r.run.shard ? r.run.id.replace(/-s\d+of\d+$/, '') : r.run.id;

const COUNTS = [
  'passed',
  'failed',
  'flaky',
  'skipped',
  'timed_out',
  'interrupted',
  'total',
];

function worst(statuses) {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('cancelled')) return 'cancelled';
  return 'passed';
}

function merge(records) {
  const lists = records.map((r) => r.results);
  return {
    scope: records[0].scope,
    suite: records[0].run.suite,
    id: logicalId(records[0]),
    finished: Math.max(...records.map((r) => Date.parse(r.run.finished_at))),
    status: worst(records.map((r) => r.run.status)),
    totals: Object.fromEntries(
      COUNTS.map((k) => [k, records.reduce((n, r) => n + r.totals[k], 0)]),
    ),
    // One shard without results makes the run's list unknown, not shorter.
    results: lists.includes(null) ? null : lists.flat(),
  };
}

/**
 * Feed runs as logical runs (the shards of one run are one), keyed by
 * suiteKey, each suite newest first.
 */
export function logicalRuns(runs) {
  const bySuite = new Map();
  for (const r of runs) {
    const key = suiteKey(r.scope, r.run.suite);
    const ofSuite = bySuite.get(key) ?? new Map();
    const id = logicalId(r);
    ofSuite.set(id, [...(ofSuite.get(id) ?? []), r]);
    bySuite.set(key, ofSuite);
  }
  const out = new Map();
  for (const [key, ofSuite] of bySuite) {
    const merged = [...ofSuite.values()].map(merge);
    out.set(
      key,
      merged.sort((a, b) => b.finished - a.finished),
    );
  }
  return out;
}

/** A recovered flake is a pass (its run is `passed`); a skip is not counted. */
export const passCounts = (t) => ({
  numerator: t.passed + t.flaky,
  denominator: t.total - t.skipped,
});

/**
 * Rounded DOWN to one decimal from integers: 996/1000 is 99.6% and 999/1000
 * is never 100%. An empty denominator is ABSENT, never 0%.
 */
export function percent(numerator, denominator) {
  if (!(denominator > 0)) return ABSENT;
  return `${(Math.floor((numerator * 1000) / denominator) / 10).toFixed(1)}%`;
}

/** An assessment value in its unit; a ratio rounds down like percent(). */
export function formatMeasure(value, unit) {
  // The schema allows a boolean measurement; it is a value, not an absence.
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null || !Number.isFinite(value)) return ABSENT;
  // The epsilon absorbs float error (0.57 * 1000 = 569.999…), not real data.
  if (unit === 'ratio')
    return `${(Math.floor(value * 1000 + 1e-9) / 10).toFixed(1)}%`;
  if (unit === 'ms') return `${Math.round(value)} ms`;
  return String(value);
}

export const isDark = (finishedMs, now) =>
  now - finishedMs > DARK_AFTER_DAYS * DAY_MS;

export const ageDays = (isoTime, now) =>
  Math.floor((now - Date.parse(isoTime)) / DAY_MS);
