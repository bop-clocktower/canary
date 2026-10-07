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

/**
 * {reported, total} for a sharded run, else null. A re-run of only the failed
 * shard, or a shard that never uploaded, leaves fewer distinct indices than
 * `shard.total`: such a run measured part of the suite (#1200).
 */
function shardsOf(records) {
  const shard = records[0].run.shard;
  if (!shard) return null;
  const reported = new Set(records.map((r) => r.run.shard?.index)).size;
  return { reported, total: shard.total };
}

function merge(records) {
  const lists = records.map((r) => r.results);
  const shards = shardsOf(records);
  return {
    scope: records[0].scope,
    suite: records[0].run.suite,
    id: logicalId(records[0]),
    // NaN when any shard's finish is not a real date (it passes the pattern).
    finished: Math.max(...records.map((r) => Date.parse(r.run.finished_at))),
    status: worst(records.map((r) => r.run.status)),
    shards,
    incomplete: shards !== null && shards.reported < shards.total,
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
    // An undated run sorts last: NaN would otherwise sort first and pose as
    // the suite's latest run.
    const when = (r) => (Number.isFinite(r.finished) ? r.finished : -Infinity);
    out.set(
      key,
      merged.sort((a, b) => when(b) - when(a)),
    );
  }
  return out;
}

/**
 * A recovered flake is a pass (its run is `passed`). Skipped and interrupted
 * tests did not run (failures-by-area files both as "not run"), so neither is
 * counted for or against the rate.
 */
export const passCounts = (t) => ({
  numerator: t.passed + t.flaky,
  denominator: t.total - t.skipped - t.interrupted,
});

/**
 * Why a logical run has no pass rate, or null. Every panel that prints a
 * run's count or rate asks this first, so none prints "0/0" or "40/40" over a
 * run that measured nothing or measured part of the suite (#1200).
 */
export function rateProblem(run) {
  if (run.incomplete)
    return `${run.shards.reported} of ${run.shards.total} shards reported`;
  if (!(passCounts(run.totals).denominator > 0)) return 'no tests counted';
  return null;
}

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
  // The epsilon absorbs float error (0.57 * 1000 = 569.9999999999999, off by
  // ~1e-13), and is small enough that 1 - 1e-13 still rounds down to 99.9%.
  if (unit === 'ratio')
    return `${(Math.floor(value * 1000 + 1e-11) / 10).toFixed(1)}%`;
  if (unit === 'ms') return `${Math.round(value)} ms`;
  return String(value);
}

/** A finish time this far ahead of the reader's clock is not trusted. */
const FUTURE_SKEW_MS = DAY_MS;

/**
 * Why a finish time cannot be read as "recent", or null: `undated` (not a real
 * date) or `future` (more than a day ahead: clock skew).
 */
export function timeProblem(finishedMs, now) {
  if (!Number.isFinite(finishedMs)) return 'undated';
  if (finishedMs - now > FUTURE_SKEW_MS) return 'future';
  return null;
}

/** An undated run is dark: it is no evidence of a recent run. */
export const isDark = (finishedMs, now) =>
  !Number.isFinite(finishedMs) || now - finishedMs > DARK_AFTER_DAYS * DAY_MS;

/** "14h ago" / "3d ago"; a time this page cannot age is ABSENT. */
export function ago(finishedMs, now) {
  if (timeProblem(finishedMs, now)) return ABSENT;
  // Inside the skew allowance, but still ahead: say so, not "just now".
  if (finishedMs - now > 60_000) return 'ahead of this clock';
  const hours = Math.floor((now - finishedMs) / 3_600_000);
  if (hours < 1) return 'just now';
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Why the katana register was not read, or null (#1199). `register: []` is
 * ambiguous on its own; canary-starling marks a dark ledger with a
 * not-assessed `canary.katana` / `register` assessment, so an empty register
 * WITHOUT that marker was read and is genuinely empty.
 */
export function registerUnread(doc) {
  const marker = doc.assessments.find(
    (a) =>
      a.source === 'canary.katana' &&
      a.metric === 'register' &&
      a.status === 'not-assessed',
  );
  return marker ? marker.reason : null;
}

export const ageDays = (isoTime, now) =>
  Math.floor((now - Date.parse(isoTime)) / DAY_MS);
