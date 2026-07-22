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
      for (const t of record.tests ?? []) {
        const name = t.test_name;
        let c = counts.get(name);
        if (!c) {
          c = {
            test_name: name,
            test_file: t.test_file ?? '',
            suite: t.suite ?? record.suite ?? '',
            area: t.area ?? null,
            flake_count: 0,
            pass_count: 0,
            fail_count: 0,
            total_runs: 0,
            last_seen_run: null,
          };
          counts.set(name, c);
        }
        c.total_runs += 1;
        const status = t.status ?? '';
        if (status === 'flaky') c.flake_count += 1;
        else if (status === 'passed') c.pass_count += 1;
        else if (status === 'failed') c.fail_count += 1;
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
    const records = this.readAll();
    const timeline: TimelineEntry[] = [];
    for (const record of records) {
      for (const t of record.tests ?? []) {
        if (t.test_name === testName) {
          timeline.push({
            run_id: record.run_id,
            suite: record.suite ?? '',
            branch: record.branch ?? '',
            commit_sha: record.commit_sha ?? '',
            timestamp: record.timestamp ?? '',
            status: t.status ?? '',
            failure_category: t.failure_category ?? null,
            error_text: t.error_text ?? null,
            retry_count: t.retry_count ?? 0,
          });
        }
      }
    }
    return timeline.sort((a, b) => cmp(a.timestamp, b.timestamp));
  }

  querySummary(suite: string, runs: number): SummaryResult {
    const records = this.readAll();
    const suiteRecords = records.filter((r) => r.suite === suite);
    const recent = runs > 0 ? suiteRecords.slice(-runs) : suiteRecords;
    if (recent.length === 0) {
      return { suite, total_runs: 0, avg_pass_rate: 0.0 };
    }

    const rates: number[] = [];
    for (const r of recent) {
      const total = r.total ?? 0;
      const passed = r.passed ?? 0;
      if (total > 0) rates.push((passed / total) * 100);
    }
    const avg =
      rates.length > 0
        ? round1(rates.reduce((a, b) => a + b, 0) / rates.length)
        : 0.0;

    return {
      suite,
      total_runs: recent.length,
      avg_pass_rate: avg,
      runs: recent.map((r) => ({
        run_id: r.run_id,
        branch: r.branch ?? '',
        timestamp: r.timestamp ?? '',
        passed: r.passed ?? 0,
        failed: r.failed ?? 0,
        flaky: r.flaky ?? 0,
        total: r.total ?? 0,
      })),
    };
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type { TestResultRecord };
