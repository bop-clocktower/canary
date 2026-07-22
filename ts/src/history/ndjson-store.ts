/**
 * Local NDJSON-backed history store — the TS side of the TS↔Python seam.
 *
 * Reads `history-v2.jsonl` (one JSON RunRecord per line) written by the Python
 * `LocalHistoryStore`. Faithful port of the query_* semantics from
 * `agent/history/local_store.py`.
 *
 * Deviation from the Python reader (deliberate): where Python's `_read_all`
 * swallows any parse error and returns `[]`, this reader throws on malformed
 * JSON and on an explicit unrecognized `schema_version`, so a corrupt or
 * future-version history fails loudly rather than silently analysing nothing.
 */

import { readFileSync } from 'node:fs';

import { def } from '../util/coalesce.js';
import { round1 } from '../util/round.js';
import { SCHEMA_VERSION } from './record.js';
import type { RunRecord, TestResultRecord, TimelineEntry } from './record.js';

export interface FlakyQueryRow {
  test_name: string;
  test_file: string;
  suite: string;
  area: string | null;
  flake_count: number;
  pass_count: number;
  fail_count: number;
  total_runs: number;
  last_seen_run: string | null;
  flake_rate_pct: number;
}

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

    const records: RunRecord[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const record = JSON.parse(line) as RunRecord;
      const version = record.schema_version;
      if (version !== undefined && version !== SCHEMA_VERSION) {
        throw new Error(
          `Unsupported history schema_version ${version} (expected ${SCHEMA_VERSION})`,
        );
      }
      records.push(record);
    }
    return records;
  }

  queryFlaky(
    window: number,
    suite: string | null,
    minRate: number,
  ): FlakyQueryRow[] {
    let records = this.readAll();
    if (suite) records = records.filter((r) => r.suite === suite);
    records = records.slice(-window);

    const counts = new Map<string, Omit<FlakyQueryRow, 'flake_rate_pct'>>();
    for (const record of records) {
      for (const t of def(record.tests, [])) {
        let c = counts.get(t.test_name);
        if (!c) {
          c = newFlakyCounter(record, t);
          counts.set(t.test_name, c);
        }
        c.total_runs += 1;
        applyStatus(c, def(t.status, ''));
        c.last_seen_run = record.run_id;
      }
    }

    const results: FlakyQueryRow[] = [];
    for (const c of counts.values()) {
      if (c.total_runs === 0) continue;
      const rate = round1((c.flake_count / c.total_runs) * 100);
      if (rate >= minRate) results.push({ ...c, flake_rate_pct: rate });
    }

    return results.sort((a, b) => b.flake_rate_pct - a.flake_rate_pct);
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
    const suiteRecords = this.readAll().filter((r) => r.suite === suite);
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
// complexity threshold. Each isolates one dense `??`-fallback cluster.
// ---------------------------------------------------------------------------

function newFlakyCounter(
  record: RunRecord,
  t: TestResultRecord,
): Omit<FlakyQueryRow, 'flake_rate_pct'> {
  return {
    test_name: t.test_name,
    test_file: def(t.test_file, ''),
    suite: def(t.suite, def(record.suite, '')),
    area: def(t.area, null),
    flake_count: 0,
    pass_count: 0,
    fail_count: 0,
    total_runs: 0,
    last_seen_run: null,
  };
}

function applyStatus(
  c: Omit<FlakyQueryRow, 'flake_rate_pct'>,
  status: string,
): void {
  if (status === 'flaky') c.flake_count += 1;
  else if (status === 'passed') c.pass_count += 1;
  else if (status === 'failed') c.fail_count += 1;
}

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

export type { TestResultRecord };
