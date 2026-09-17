/**
 * Write-side schema for run-history records.
 *
 * `record.ts` holds
 * the *read* shapes (loose, as parsed from disk); this module holds the *write*
 * inputs (the dataclass field sets) and the serializers that produce the on-disk
 * and remote-table shapes.
 *
 * The field sets still match what Python's `asdict()` produced, with one
 * deliberate addition since the Python engine was retired at v6.0.0: the local
 * record carries `schema_version` (#701). See `serializeLocalRecord`.
 */

import { def } from '../util/coalesce.js';
import { SCHEMA_VERSION } from './record.js';
import type { ReplayContext } from './keys/replay-record.js';

/** Mirrors the Python `RunRecord` dataclass. */
export interface RunInput {
  run_id: string;
  suite: string;
  repo: string;
  branch: string;
  commit_sha: string;
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  commit_message?: string | null;
  env?: string | null;
  base_url?: string | null;
  duration_ms?: number | null;
  /** Which reader produced the run (#604); local-only, see `serializeLocalRecord`. */
  reporter_format?: string | null;
  replay?: ReplayContext; // #461, local-only like reporter_format
}

/** Mirrors the Python `TestResult` dataclass. */
export interface TestResultInput {
  run_id: string;
  suite: string;
  repo: string;
  test_name: string;
  test_file: string;
  status: string;
  area?: string | null;
  failure_category?: string | null;
  error_text?: string | null;
  retry_count?: number;
  duration_ms?: number | null;
  tags?: string[];
  start_index?: number; // #461, local-only (no remote column)
}

/** `{suite}-{commit[:8]}-{epoch}` — identical to Python `make_run_id`. */
export function makeRunId(
  suite: string,
  commitSha: string,
  timestampEpoch: number,
): string {
  return `${suite}-${commitSha.slice(0, 8)}-${timestampEpoch}`;
}

/** `asdict(run)` — every RunRecord field, optionals defaulted to null. */
export function serializeRun(run: RunInput): Record<string, unknown> {
  return {
    run_id: run.run_id,
    suite: run.suite,
    repo: run.repo,
    branch: run.branch,
    commit_sha: run.commit_sha,
    timestamp: run.timestamp,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    flaky: run.flaky,
    skipped: run.skipped,
    commit_message: def(run.commit_message, null),
    env: def(run.env, null),
    base_url: def(run.base_url, null),
    duration_ms: def(run.duration_ms, null),
  };
}

/** `asdict(t)` — every TestResult field, optionals/defaults applied. */
export function serializeTestResult(
  t: TestResultInput,
): Record<string, unknown> {
  return {
    run_id: t.run_id,
    suite: t.suite,
    repo: t.repo,
    test_name: t.test_name,
    test_file: t.test_file,
    status: t.status,
    area: def(t.area, null),
    failure_category: def(t.failure_category, null),
    error_text: def(t.error_text, null),
    retry_count: def(t.retry_count, 0),
    duration_ms: def(t.duration_ms, null),
    tags: def(t.tags, []),
  };
}

function serializeLocalTest(t: TestResultInput): Record<string, unknown> {
  const { start_index } = t;
  const row = serializeTestResult(t);
  return start_index === undefined ? row : { ...row, start_index };
}

/**
 * The nested NDJSON line shape written by the local store: a serialized run
 * with its `tests` embedded.
 *
 * `schema_version` is stamped **here**, in the one serializer every local
 * writer goes through, rather than at each call site (#701). A writer that has
 * to remember the field is a writer that eventually forgets it — and an
 * unstamped row is invisible to the reader's version guard, so the guard could
 * never fire on the store's own history. Stamping by construction is what makes
 * "every row is self-describing" a property instead of a convention.
 *
 * Deliberately absent from `serializeRun`/`serializeTestResult`: those map to
 * the remote store's table columns, which have no such field. `reporter_format`
 * (#604) is stamped here for the same reason -- the remote tables have no such
 * column, and adding it to `serializeRun` would make every upsert fail.
 */
export function serializeLocalRecord(
  run: RunInput,
  results: TestResultInput[],
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    // Omitted rather than nulled when the writer did not know its reader: an
    // absent stamp already means "unknown capability" to the read side, and
    // writing `null` would change the on-disk shape of every `push`ed row.
    ...(run.reporter_format === undefined || run.reporter_format === null
      ? {}
      : { reporter_format: run.reporter_format }),
    ...serializeRun(run),
    ...(run.replay === undefined ? {} : { replay: run.replay }),
    tests: results.map(serializeLocalTest),
  };
}
