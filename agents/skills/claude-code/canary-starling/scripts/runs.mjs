// runs -- run-history rows and canary.run/1 files as one list of run records.
//
// A history row has no start time, no scope and no producer. Scope comes
// from the caller (D2: never inferred); started_at is timestamp minus
// duration_ms, and a row without both is LEFT OUT and named -- an invented
// time is a lie the contract cannot detect (#1151 phase 2, P3).

import { loadRuns } from '../../canary-signal/scripts/sources.mjs';

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA = /^[0-9a-f]{7,64}$/;
/** The only per-test statuses the history readers write. */
const STATUSES = ['passed', 'failed', 'flaky', 'skipped'];

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function toResult(t) {
  return {
    title: t.test_name,
    file: t.test_file,
    status: t.status,
    duration_ms: count(t.duration_ms),
    retries: count(t.retry_count),
    area: t.area ?? null,
    tags: [],
    error: t.error_text ? { message: t.error_text, stack: null } : null,
  };
}

const COUNTS = ['passed', 'failed', 'flaky', 'skipped'];
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Why the row's counts cannot be carried, or null. A malformed count is never
 * zeroed, and a row with no tests and no count measured nothing (D4).
 */
function countsProblem(row) {
  const bad = COUNTS.find((f) => row[f] != null && !isCount(row[f]));
  if (bad) return `${bad} is ${JSON.stringify(row[bad])}, not a count`;
  if (!Array.isArray(row.tests) && !COUNTS.some((f) => isCount(row[f])))
    return 'neither tests nor any count';
  return null;
}

function results(row) {
  const problem = countsProblem(row);
  if (problem) return { error: problem };
  if (!Array.isArray(row.tests)) return { list: null };
  // An absolute or drive-lettered test_file (vitest rows can hold one) would
  // make the whole feed invalid, so its row is left out like any other.
  const bad = row.tests.find(
    (t) =>
      !STATUSES.includes(t.status) ||
      !t.test_file ||
      !t.test_name ||
      /^(\/|[A-Za-z]:[\\/])/.test(t.test_file),
  );
  if (bad)
    return {
      error: `a test with status ${JSON.stringify(bad.status)} or no file/name`,
    };
  return { list: row.tests.map(toResult) };
}

function totals(row, list) {
  const n = (s) =>
    list ? list.filter((r) => r.status === s).length : count(row[s]);
  const t = {
    passed: n('passed'),
    failed: n('failed'),
    flaky: n('flaky'),
    skipped: n('skipped'),
    timed_out: 0,
    interrupted: 0,
  };
  return { ...t, total: t.passed + t.failed + t.flaky + t.skipped };
}

// {run, skipped: null} on success; {run: null, skipped: reason} when left out.
// (No JSDoc @returns: allowJs would type `run` as object|null and break typecheck.)
export function historyToRun(row, scope) {
  const why = (reason) => ({
    run: null,
    skipped: `history run ${row.run_id}: ${reason}`,
  });
  if (typeof row.timestamp !== 'string' || !TIMESTAMP.test(row.timestamp))
    return why('no ISO timestamp');
  // ISO-shaped is not a date: month 13 or hour 25 would throw at toISOString.
  if (!Number.isFinite(Date.parse(row.timestamp)))
    return why('unparseable timestamp');
  if (!(typeof row.duration_ms === 'number' && row.duration_ms > 0))
    return why('no duration_ms, so no start time');
  const res = results(row);
  if (res.error) return why(res.error);
  const t = totals(row, res.list);
  return {
    skipped: null,
    run: {
      contract: 'canary.run/1',
      scope,
      producer: {
        name: 'canary-history',
        version: String(row.schema_version ?? 2),
        channel: 'history-store',
      },
      run: runHeader(row, t),
      totals: t,
      results: res.list,
      collected: null,
    },
  };
}

/** The record's `run` block, for a row historyToRun has already admitted. */
function runHeader(row, t) {
  return {
    id: row.run_id,
    suite: row.suite,
    branch: row.branch || null,
    commit_sha: SHA.test(row.commit_sha ?? '') ? row.commit_sha : null,
    started_at: new Date(
      Date.parse(row.timestamp) - row.duration_ms,
    ).toISOString(),
    finished_at: row.timestamp,
    ci_url: null,
    status: t.failed > 0 ? 'failed' : 'passed',
    shard: null,
  };
}

/** The history store as run records; each left-out row is named in `notes`. */
export function historyRuns(file, scope, notes) {
  const runs = [];
  for (const row of loadRuns(file)) {
    const out = historyToRun(row, scope);
    if (out.run) runs.push(out.run);
    else notes.push(`left out ${out.skipped}`);
  }
  return runs;
}

/** D15: the last N runs per (scope, suite) keep the feed loadable in one fetch. */
export const RUNS_PER_SUITE = 30;

const suiteKey = (r) => `${r.scope.id}\u0000${r.scope.env}\u0000${r.run.suite}`;

/**
 * A canary.run/1 record is a whole run or one shard of it; a shard's id is
 * its run's id plus `-sNofM` (#1148). Windows and counts are per LOGICAL run.
 */
export const logicalId = (r) =>
  r.run.shard ? r.run.id.replace(/-s\d+of\d+$/, '') : r.run.id;

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const it of items) {
    const k = keyOf(it);
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return groups;
}

/** A logical run finishes when its last shard does. */
const finishedAt = (records) =>
  Math.max(...records.map((r) => Date.parse(r.run.finished_at)));

/**
 * Why a logical run cannot be vouched for as a whole run, or null: a sharded
 * run with fewer distinct shard indices than its `shard.total` measured part
 * of the suite ("re-run failed jobs" reruns one shard under a new attempt id;
 * a cancelled shard never uploads). A duplicate index is one shard (#1200).
 */
function missingShards(records) {
  const shards = records.map((r) => r.run.shard).filter(Boolean);
  if (shards.length === 0) return null;
  const total = Math.max(...shards.map((s) => s.total));
  // An index past `total` is not one of the run's shards.
  const indices = shards.map((s) => s.index).filter((i) => i <= total);
  const have = new Set(indices).size;
  return have < total ? `${have} of ${total} shards reported` : null;
}

/**
 * Newest first per suite, by logical run. `window` keeps every kept record's
 * results (flaky[] needs them); `feed` drops results on all but every shard
 * of each suite's newest logical run. Dropped results become `results: null`
 * and the run's totals stay, so the run still validates ("not carried", never
 * "zero tests"). A logical run missing shards is left out and named in
 * `notes`, like a history row starling cannot vouch for.
 */
export function selectRuns(runs, notes = []) {
  const window = [];
  const feed = [];
  for (const group of groupBy(runs, suiteKey).values()) {
    const kept = [...groupBy(group, logicalId)]
      .filter(([id, records]) => {
        const why = missingShards(records);
        if (why)
          notes.push(
            `left out run ${id} (suite ${records[0].run.suite}): ${why}`,
          );
        return !why;
      })
      .map(([, records]) => records)
      .sort((a, b) => finishedAt(b) - finishedAt(a))
      .slice(0, RUNS_PER_SUITE);
    kept.forEach((records, i) => {
      window.push(...records);
      feed.push(...(i === 0 ? records : records.map(withoutResults)));
    });
  }
  return { window, feed };
}

const withoutResults = (r) => ({ ...r, results: null });
