/**
 * TypeScript types for the v2 run-history record schema.
 *
 * Mirrors `agent/history/schema.py` (RunRecord + TestResult) as persisted, one
 * JSON object per line, in `test-results/reports/history-v2.jsonl`.
 *
 * Every row the store writes now carries its own `schema_version` (#701) — the
 * version guard can only refuse data it can identify, and before the stamp the
 * store's own history was the one thing it could never check.
 *
 * A row with no version is a **legacy row**, written before that stamp landed.
 * It is resolved to `LEGACY_UNVERSIONED_SCHEMA_VERSION`, not to "current" — see
 * `resolveSchemaVersion` for why the difference is load-bearing.
 */

/** The schema version this reader understands, and every writer stamps. */
export const SCHEMA_VERSION = 2;

/**
 * The version an unstamped row was actually written at.
 *
 * **A frozen literal, never an alias of `SCHEMA_VERSION`.** Unversioned rows
 * can only be v2: v2 is the sole version this store has ever had (the earlier
 * "v1" lived in a differently-named file), and from #701 onward every row is
 * stamped. So the value is a historical fact, not a default.
 *
 * Aliasing it to `SCHEMA_VERSION` would recreate the #701 bug on the day the
 * version bumps: legacy v2 rows would be read as v3 and silently
 * misinterpreted, which is precisely the guard's purpose to prevent.
 */
export const LEGACY_UNVERSIONED_SCHEMA_VERSION = 2;

/**
 * The version a record should be read as.
 *
 * Deliberately conservative: an unversioned row resolves to the version it was
 * written at, so the next `SCHEMA_VERSION` bump makes the reader **refuse**
 * legacy rows loudly rather than reinterpret them under new semantics. That
 * bump therefore has to ship a migration (rewrite the file with a stamp, or add
 * an explicit upgrade path) — which is the point. Today the two constants are
 * equal, so this changes nothing observable; it only decides what happens next.
 */
export function resolveSchemaVersion(record: RunRecord): number {
  return record.schema_version ?? LEGACY_UNVERSIONED_SCHEMA_VERSION;
}

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
  /**
   * Stamped by every writer since #701. Absent only on legacy rows, which
   * resolve to `LEGACY_UNVERSIONED_SCHEMA_VERSION`; any version this build does
   * not understand throws.
   */
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
