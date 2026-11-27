// runtime -- where suite time went, and when it grew (spec D6, D7, D12).
//
// Reads the run-history store, `test-results/reports/history-v2.jsonl`: one
// RunRecord per line (ts/src/history/schema.ts). Ivy reads `timestamp`,
// `commit_sha`, `run_id` and per test `test_file`, `test_name`, `duration_ms`.
// It writes nothing back and adds no field (ADR 0039, Consequences).
//
// This is not canary-ci-ready's runtime grade: no p95, no pass/warn/fail, no
// baseline. A series is listed when it grew by the stated THRESHOLDS, which
// are inclusion rules for a list, printed with the report.

import fs from 'node:fs';

/** Where `canary history record` writes, relative to the working directory. */
export const DEFAULT_HISTORY = 'test-results/reports/history-v2.jsonl';

/** Mirrors SUPPORTED_SCHEMA_VERSIONS in ts/src/history/record.ts. */
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

/** Inclusion rules for a creep row, printed with every report. */
export const THRESHOLDS = Object.freeze({
  min_observations: 6,
  min_ratio: 1.5,
  min_gap_ms: 100,
});

/** Each side of a split needs this many observations. */
const MIN_SIDE = 3;

/** "Where the time went" reads each file's most recent runs. */
const RECENT_RUNS = 5;
const TOP_FILES = 10;

const NO_FILE = '(no file)';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function recordProblem(record) {
  if (!isPlainObject(record)) return 'not an object';
  const version = record.schema_version ?? 2;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    return `unsupported schema_version ${JSON.stringify(version)}`;
  }
  if (record.tests !== undefined && !Array.isArray(record.tests)) {
    return 'tests is not an array';
  }
  return null;
}

function parseRecord(line, lineNo) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (exc) {
    throw new Error(
      `malformed history record at line ${lineNo}: ${exc.message}`,
    );
  }
  const problem = recordProblem(record);
  if (problem) {
    throw new Error(`malformed history record at line ${lineNo}: ${problem}`);
  }
  return record;
}

/**
 * @param {string} file path to history-v2.jsonl
 * @returns {Array<Record<string, any>>} one record per non-blank line
 */
export function loadRuns(file) {
  if (!fs.existsSync(file)) throw new Error(`history store not found: ${file}`);
  const runs = [];
  fs.readFileSync(file, 'utf8')
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line) runs.push(parseRecord(line, i + 1));
    });
  return runs;
}

/**
 * A named store must exist; the default one may be absent (a dark source).
 *
 * @param {string} file
 * @param {boolean} explicit true when the caller passed --history
 */
export function readStore(file, explicit) {
  if (fs.existsSync(file) || explicit)
    return { runs: loadRuns(file), dark: null };
  return { runs: [], dark: `no history store at ${file}` };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The split k that maximizes mean(after) - mean(before), or -1. */
function bestSplit(values) {
  const prefix = [0];
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v);
  const n = values.length;
  let best = -1;
  let bestGap = 0;
  for (let k = MIN_SIDE; k <= n - MIN_SIDE; k += 1) {
    const gap = (prefix[n] - prefix[k]) / (n - k) - prefix[k] / k;
    if (gap > bestGap) [best, bestGap] = [k, gap];
  }
  return best;
}

/**
 * When a duration series stepped up, if it did by the THRESHOLDS.
 *
 * @param {Array<{ms: number, at: object}>} points oldest first
 */
export function changepoint(points) {
  if (points.length < THRESHOLDS.min_observations) return null;
  const values = points.map((p) => p.ms);
  const k = bestSplit(values);
  if (k === -1) return null;
  const before = median(values.slice(0, k));
  const after = median(values.slice(k));
  const gap = after - before;
  if (gap < THRESHOLDS.min_gap_ms || after < before * THRESHOLDS.min_ratio) {
    return null;
  }
  return {
    before_median_ms: before,
    after_median_ms: after,
    gap_ms: gap,
    observations: points.length,
    grew_at: points[k].at,
  };
}

const orNull = (v) => v ?? null;

const atOf = (run) => ({
  timestamp: orNull(run.timestamp),
  commit_sha: orNull(run.commit_sha),
  run_id: orNull(run.run_id),
});

const byTimestamp = (a, b) =>
  String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));

const isDuration = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function push(map, key, point) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(point);
}

/** Per-test points and per-file per-run sums, oldest run first. */
function buildSeries(runs) {
  const tests = new Map();
  const files = new Map();
  for (const run of [...runs].sort(byTimestamp)) {
    const perFile = new Map();
    for (const t of Array.isArray(run.tests) ? run.tests : []) {
      if (!isPlainObject(t) || !isDuration(t.duration_ms)) continue;
      const file = String(t.test_file ?? NO_FILE);
      const key = JSON.stringify([file, String(t.test_name ?? '')]);
      push(tests, key, { ms: t.duration_ms, at: atOf(run) });
      perFile.set(file, (perFile.get(file) ?? 0) + t.duration_ms);
    }
    for (const [file, ms] of perFile) push(files, file, { ms, at: atOf(run) });
  }
  return { tests, files };
}

function whereTimeWent(files) {
  const rows = [...files].map(([file, points]) => ({
    file,
    median_ms: median(points.slice(-RECENT_RUNS).map((p) => p.ms)),
  }));
  const total = rows.reduce((sum, r) => sum + r.median_ms, 0);
  return rows
    .sort((a, b) => b.median_ms - a.median_ms || (a.file < b.file ? -1 : 1))
    .slice(0, TOP_FILES)
    .map((r) => ({
      ...r,
      share: total ? Math.round((r.median_ms / total) * 1000) / 1000 : 0,
    }));
}

function creepRows(tests, files) {
  const rows = [];
  for (const [key, points] of tests) {
    const cp = changepoint(points);
    const [file, test] = JSON.parse(key);
    if (cp) rows.push({ scope: 'test', file, test, ...cp });
  }
  for (const [file, points] of files) {
    const cp = changepoint(points);
    if (cp) rows.push({ scope: 'file', file, test: null, ...cp });
  }
  const rank = (r) => [r.file, r.scope === 'file' ? '' : r.test].join('\n');
  return rows.sort(
    (a, b) => b.gap_ms - a.gap_ms || (rank(a) < rank(b) ? -1 : 1),
  );
}

/**
 * @param {Array<Record<string, any>>} runs
 */
export function analyzeRuntime(runs) {
  const { tests, files } = buildSeries(runs);
  const longEnough = [...tests.values()].filter(
    (p) => p.length >= THRESHOLDS.min_observations,
  ).length;
  return {
    denominator: {
      runs: runs.length,
      timed_tests: tests.size,
      series_long_enough: longEnough,
    },
    where_time_went: whereTimeWent(files),
    creep: creepRows(tests, files),
  };
}
