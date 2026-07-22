/**
 * TypeScript types for the v2 run-history record schema.
 *
 * Mirrors `agent/history/schema.py` (RunRecord + TestResult) as persisted, one
 * JSON object per line, in `test-results/reports/history-v2.jsonl`.
 *
 * The on-disk records written by the Python engine do NOT carry a per-record
 * version field (the "v2" lives in the filename). The reader therefore treats a
 * missing `schema_version` as the current version, but throws on an explicit
 * unrecognized one — a forward-compat guard, exercised by the store tests.
 */

/** The schema version this reader understands. */
export const SCHEMA_VERSION = 2;

export interface TestResultRecord {
  test_name: string;
  status: string;
  suite?: string;
  test_file?: string;
  area?: string | null;
  failure_category?: string | null;
  error_text?: string | null;
  retry_count?: number;
}

export interface RunRecord {
  run_id: string;
  suite: string;
  branch?: string;
  commit_sha?: string;
  timestamp?: string;
  total?: number;
  passed?: number;
  failed?: number;
  flaky?: number;
  skipped?: number;
  /** Absent in real files (treated as current); an explicit unknown value throws. */
  schema_version?: number;
  tests?: TestResultRecord[];
}

/** One entry of a per-test timeline (query_timeline output). */
export interface TimelineEntry {
  run_id: string;
  suite: string;
  branch: string;
  commit_sha: string;
  timestamp: string;
  status: string;
  failure_category: string | null;
  error_text: string | null;
  retry_count: number;
}
