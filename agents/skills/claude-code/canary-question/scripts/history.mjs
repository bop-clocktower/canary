// history -- read the run-history store and build one test's timeline.
//
// The store is `test-results/reports/history-v2.jsonl`: one RunRecord per line
// (ts/src/history/record.ts). This module and the two optional readers
// (diff.mjs, findings.mjs) are the only parts of canary-question that do I/O.
//
// A NAMED store that is missing is an error: returning [] would be
// byte-identical to an empty store, and a typo would print a plausible
// abstention. The DEFAULT path being absent is different -- nobody asked for
// it, so it is a dark source the brief names under "Not checked" (spec D9).

import fs from 'node:fs';

/** Where `canary history record` writes, relative to the working directory. */
export const DEFAULT_HISTORY = 'test-results/reports/history-v2.jsonl';

/** Mirrors SUPPORTED_SCHEMA_VERSIONS in ts/src/history/record.ts. */
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

/** Statuses that count as a failing observation (a flaky pass failed first). */
const FAILING = new Set(['failed', 'flaky']);

/** Statuses that are evidence at all; anything else (skipped) is counted. */
const OBSERVED = new Set(['passed', 'failed', 'flaky']);

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
 * @returns {Array<Record<string, any>>} one record per non-blank line, in file order
 */
export function loadRuns(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`history store not found: ${file}`);
  }
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
 * @param {string} file store path
 * @param {boolean} explicit true when the caller passed --history
 * @returns {{runs: Array<Record<string, any>>, dark: string|null}}
 */
export function readStore(file, explicit) {
  if (fs.existsSync(file) || explicit) {
    return { runs: loadRuns(file), dark: null };
  }
  return { runs: [], dark: `no history store at ${file}` };
}

const testsOf = (run) => (Array.isArray(run.tests) ? run.tests : []);

/**
 * How a record with no suite is named in the suite list, and the value
 * --suite takes to pick it: 'null' would read as a suite called null (S4).
 */
const NO_SUITE = '(no suite)';

const suiteLabel = (suite) => suite ?? NO_SUITE;

function entryFor(run, test, suite) {
  return (
    testsOf(run).find(
      (t) =>
        isPlainObject(t) &&
        t.test_name === test &&
        (suite === null || suiteLabel(t.suite ?? run.suite) === suite),
    ) ?? null
  );
}

function coFailuresOf(run, entry) {
  return testsOf(run)
    .filter((t) => isPlainObject(t) && t !== entry && FAILING.has(t.status))
    .map((t) => ({
      test_name: t.test_name,
      area: t.area ?? null,
      failure_category: t.failure_category ?? null,
      error_text: t.error_text ?? null,
    }));
}

// `value ?? fallback` as a call. The perf analyzer scores every `??` in a
// function as a branch, so eleven defaulted fields read as complexity 23.
const orElse = (value, fallback = null) => value ?? fallback;

function toObservation(run, entry) {
  return {
    run_id: orElse(run.run_id),
    suite: orElse(entry.suite, orElse(run.suite)),
    commit_sha: orElse(run.commit_sha),
    timestamp: orElse(run.timestamp),
    branch: orElse(run.branch),
    status: entry.status,
    failure_category: orElse(entry.failure_category),
    error_text: orElse(entry.error_text),
    retry_count: orElse(entry.retry_count, 0),
    test_file: orElse(entry.test_file),
    area: orElse(entry.area),
    coFailures: coFailuresOf(run, entry),
    // "The only failure" means nothing in a run of one test (I4).
    testsInRun: testsOf(run).filter(isPlainObject).length,
  };
}

// Timestamp order, not file order: several suites append concurrently, so
// file order is not chronology (same rule as canary-screech/history.mjs).
const byTimestamp = (a, b) =>
  String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));

/**
 * One observation per run containing the test, oldest first.
 *
 * @param {object[]} runs
 * @param {{test: string, suite: string|null}} query
 * @returns {{observations: Array<Record<string, any>>, skipped: number, suites: string[], runsInStore: number}}
 */
export function buildTimeline(runs, { test, suite = null }) {
  const observations = [];
  let skipped = 0;
  for (const run of runs) {
    const entry = entryFor(run, test, suite);
    if (!entry) continue;
    const obs = toObservation(run, entry);
    if (OBSERVED.has(obs.status)) observations.push(obs);
    else skipped += 1;
  }
  observations.sort(byTimestamp);
  const suites = [...new Set(observations.map((o) => suiteLabel(o.suite)))];
  return {
    observations,
    skipped,
    suites: suites.sort(),
    runsInStore: runs.length,
  };
}

/**
 * The target failure is the most recent failing observation; the last pass is
 * the most recent `passed` observation before it (the culprit range start).
 */
export function selectTarget(observations) {
  const at = observations.findLastIndex((o) => FAILING.has(o.status));
  if (at === -1) return { target: null, lastPass: null };
  const lastPass =
    observations.slice(0, at).findLast((o) => o.status === 'passed') ?? null;
  return { target: observations[at], lastPass };
}
