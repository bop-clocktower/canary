/**
 * Local NDJSON-backed history store.
 *
 * Reads `history-v2.jsonl` (one JSON RunRecord per line) and answers the
 * query_* methods over it. Malformed JSON, a non-object line and an
 * unrecognized `schema_version` throw a `HistoryContentError` (naming the line)
 * instead of reading as empty, so a corrupt or future-version history fails
 * loudly rather than silently analysing nothing -- or analysing a subset.
 *
 * Version resolution lives in `resolveSchemaVersion` (#701): rows written by
 * this store carry their version, and a legacy unstamped row is read as the
 * version it was written at rather than as "current".
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { maxFlakeOrFlipRate } from '../util/alternation.js';
import { def } from '../util/coalesce.js';
import { round1 } from '../util/round.js';
import { SUPPORTED_SCHEMA_VERSIONS, resolveSchemaVersion } from './record.js';
import type { RunRecord, TestResultRecord, TimelineEntry } from './record.js';
import {
  newFlakyCounter,
  applyStatus,
  toFlakyRow,
  type FlakyCounter,
  type FlakyQueryRow,
} from './flake/rows.js';
import { serializeLocalRecord } from './schema.js';
import type { RunInput, TestResultInput } from './schema.js';

// The flaky row shape lives with its accumulator in `flake/rows.ts` (#604
// Phase 2) so that module needs no import back here; re-exported so the many
// existing `ndjson-store.js` importers are unaffected.
export type { FlakyQueryRow } from './flake/rows.js';

export interface SummaryRunRow {
  run_id: string;
  branch: string;
  timestamp: string;
  passed: number;
  failed: number;
  flaky: number;
  total: number;
}

export interface SummaryResult {
  suite: string;
  total_runs: number;
  avg_pass_rate: number;
  runs?: SummaryRunRow[];
}

/** Shared query surface (mirrors the Python HistoryStore ABC). */
export interface HistoryStore {
  queryFlaky(
    window: number,
    suite: string | null,
    minRate: number,
  ): FlakyQueryRow[];
  queryTimeline(testName: string): TimelineEntry[];
  querySummary(suite: string, runs: number): SummaryResult;
  /**
   * How many runs the store holds -- the DENOMINATOR every history-backed
   * report abstains on when it is zero (#508 Wave 4a).
   *
   * Deliberately NOT the row count of a query: zero flaky rows across 500 runs
   * is a genuine clean result, while zero rows across zero runs is an absent
   * measurement. Only this number can tell the two apart.
   */
  countRuns(): number;
}

/**
 * The store's CONTENT is unusable (#1156): a line is not valid JSON, not a JSON
 * object, or has a schema_version this reader does not support. A distinct
 * type, so a caller can turn exactly this into a skip with a reason while any
 * other error -- a bug in the reader, not a property of the file -- surfaces.
 * `line` is 1-based; `version` is set only for an unsupported schema.
 */
export class HistoryContentError extends Error {
  override readonly name = 'HistoryContentError';

  constructor(
    readonly line: number,
    readonly problem:
      'invalid JSON' | 'not a JSON object' | 'unsupported schema',
    readonly version?: unknown,
  ) {
    super(
      problem === 'unsupported schema'
        ? `Unsupported history schema_version ${String(version)} (expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}) on line ${line}`
        : `history store line ${line}: ${problem}`,
    );
  }

  /** The skip reason ci-ready and the release dossier both report. */
  reasonFor(path: string): string {
    return this.problem === 'unsupported schema'
      ? `${path} has unsupported schema ${String(this.version)} (line ${this.line}; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`
      : `${path} could not be parsed (line ${this.line}: ${this.problem})`;
  }
}

/** One non-blank NDJSON line as a RunRecord, or a HistoryContentError. */
function parseLine(line: string, lineNo: number): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new HistoryContentError(lineNo, 'invalid JSON');
  }
  // `null`, a number or an array would otherwise read as a legacy v2 row (or
  // crash resolveSchemaVersion) -- refuse it as corrupt instead.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HistoryContentError(lineNo, 'not a JSON object');
  }
  const version = resolveSchemaVersion(value as RunRecord);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    throw new HistoryContentError(lineNo, 'unsupported schema', version);
  }
  return value as RunRecord;
}

export class NdjsonHistoryStore implements HistoryStore {
  constructor(private readonly path: string) {}

  readAll(): RunRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf-8');
    } catch (err) {
      // Missing file → empty history (matches Python's exists() guard).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    // Any bad line fails the WHOLE read: dropping it and keeping the rest would
    // score a history that is not the one on disk (#1156).
    return text.split('\n').flatMap((raw, i) => {
      const line = raw.trim();
      return line ? [parseLine(line, i + 1)] : [];
    });
  }

  /** The denominator probe: how many runs this store holds (#508). */
  countRuns(): number {
    return this.readAll().length;
  }

  /**
   * Append a run + its results as one NDJSON line. Idempotent: a run whose
   * `run_id` is already present is silently skipped (matches Python
   * `LocalHistoryStore.push_run`).
   */
  pushRun(run: RunInput, results: TestResultInput[]): void {
    const existingIds = new Set(this.readAll().map((r) => r.run_id));
    if (existingIds.has(run.run_id)) return;

    const record = serializeLocalRecord(run, results);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf-8');
  }

  queryFlaky(
    window: number,
    suite: string | null,
    minRate: number,
  ): FlakyQueryRow[] {
    let records = this.readAll();
    if (suite) records = records.filter((r) => r.suite === suite);
    // #604 Phase 2: flips are only meaningful in TIME order, and the NDJSON
    // file is in APPEND order -- a backfilled run would otherwise invent or
    // hide transitions. Sort is stable and `cmp('', '')` is 0, so rows with no
    // timestamp keep their append order rather than bunching at one end.
    records = [...records].sort((a, b) =>
      cmp(def(a.timestamp, ''), def(b.timestamp, '')),
    );
    records = records.slice(-window);

    const counts = new Map<string, FlakyCounter>();
    for (const record of records) {
      for (const t of def(record.tests, [])) {
        let c = counts.get(t.test_name);
        if (!c) {
          c = newFlakyCounter(record, t);
          counts.set(t.test_name, c);
        }
        c.total_runs += 1;
        const status = def(t.status, '');
        applyStatus(c, status);
        c.statuses.push(status);
        c.last_seen_run = record.run_id;
      }
    }

    const results: FlakyQueryRow[] = [];
    for (const c of counts.values()) {
      if (c.total_runs === 0) continue;
      const row = toFlakyRow(c, minRate);
      // A row earns its place on EITHER axis: the flake rate it always did,
      // or an alternation finding the flake rate is structurally blind to.
      if (row.flake_rate_pct >= minRate || row.alternating === true) {
        results.push(row);
      }
    }

    // Decision D4: rank on whichever axis is worse, so an alternator is not
    // buried under a retry-flake. Ties keep the old flake-rate order.
    return results.sort(
      (a, b) =>
        maxFlakeOrFlipRate(b) - maxFlakeOrFlipRate(a) ||
        b.flake_rate_pct - a.flake_rate_pct,
    );
  }

  queryTimeline(testName: string): TimelineEntry[] {
    const timeline: TimelineEntry[] = [];
    for (const record of this.readAll()) {
      for (const t of def(record.tests, [])) {
        if (t.test_name === testName) timeline.push(toTimelineEntry(record, t));
      }
    }
    return timeline.sort((a, b) => cmp(a.timestamp, b.timestamp));
  }

  querySummary(suite: string, runs: number): SummaryResult {
    // "Most recent" means TIME order, not append order: a backfilled older run
    // appended last must not stand in for the latest one (same rule
    // `queryFlaky` applies, #604). Stable sort keeps untimestamped rows in place.
    const suiteRecords = this.readAll()
      .filter((r) => r.suite === suite)
      .sort((a, b) => cmp(def(a.timestamp, ''), def(b.timestamp, '')));
    const recent = runs > 0 ? suiteRecords.slice(-runs) : suiteRecords;
    if (recent.length === 0) {
      return { suite, total_runs: 0, avg_pass_rate: 0.0 };
    }
    return {
      suite,
      total_runs: recent.length,
      avg_pass_rate: avgPassRate(recent),
      runs: recent.map(toSummaryRun),
    };
  }
}

// ---------------------------------------------------------------------------
// Row-mapping helpers — extracted so the query methods stay under the arch
// complexity threshold. Each isolates one dense `??`-fallback cluster. The
// `flaky` row accumulator lives in `flake/rows.ts` (#604 Phase 2).
// ---------------------------------------------------------------------------

function toTimelineEntry(
  record: RunRecord,
  t: TestResultRecord,
): TimelineEntry {
  return {
    run_id: record.run_id,
    suite: def(record.suite, ''),
    branch: def(record.branch, ''),
    commit_sha: def(record.commit_sha, ''),
    timestamp: def(record.timestamp, ''),
    status: def(t.status, ''),
    failure_category: def(t.failure_category, null),
    error_text: def(t.error_text, null),
    retry_count: def(t.retry_count, 0),
  };
}

function toSummaryRun(r: RunRecord): SummaryRunRow {
  return {
    run_id: r.run_id,
    branch: def(r.branch, ''),
    timestamp: def(r.timestamp, ''),
    passed: def(r.passed, 0),
    failed: def(r.failed, 0),
    flaky: def(r.flaky, 0),
    total: def(r.total, 0),
  };
}

function avgPassRate(recent: RunRecord[]): number {
  const rates: number[] = [];
  for (const r of recent) {
    const total = def(r.total, 0);
    if (total > 0) rates.push((def(r.passed, 0) / total) * 100);
  }
  if (rates.length === 0) return 0.0;
  return round1(rates.reduce((a, b) => a + b, 0) / rates.length);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
