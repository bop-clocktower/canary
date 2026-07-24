// run_types -- the run.json v1 contract (trace-only), ported from the Python
// dataclasses one-for-one as the skill moves to JS.
//
// Each factory returns a plain object whose keys are declared in exactly the
// order the Python dataclass declared its fields, so JSON.stringify emits the
// same key order the old dataclasses.asdict() did. `toDict()` is therefore an
// identity pass -- the object already IS the on-disk dict shape.
//
// No `coverage` key and no `canary_run_id` key exist anywhere in this module:
// both were cut for v1 (coverage is a separate future skill; canary_run_id has
// no consumer yet). Additive-only evolution: new optional fields may be
// appended later; existing fields never change meaning.

/**
 * @typedef {{method: string, url: string, route: (string|null),
 *   status: (number|null), duration_ms: number, span_id: string,
 *   started_at: string}} RequestSpanRow
 */

/**
 * @typedef {{test_id: string, test_title: string, test_file: string,
 *   trace_id: string, outcome: string, requests: RequestSpanRow[]}} TestTraceRow
 */

/** One outbound HTTP request span. Field order matches the Python dataclass. */
export function RequestSpan({
  method,
  url,
  route,
  status,
  duration_ms,
  span_id,
  started_at,
}) {
  return { method, url, route, status, duration_ms, span_id, started_at };
}

/**
 * One test's trace bucket. `test_id` is "__setup__" for orphan (rootless)
 * traffic. `requests` defaults to a fresh empty array (mirrors the Python
 * `field(default_factory=list)`).
 * @param {{test_id: string, test_title: string, test_file: string,
 *   trace_id: string, outcome: string, requests?: RequestSpanRow[]}} f
 */
export function TestTrace({
  test_id,
  test_title,
  test_file,
  trace_id,
  outcome,
  requests = [],
}) {
  return { test_id, test_title, test_file, trace_id, outcome, requests };
}

/**
 * The trace block: total request spans + per-test buckets.
 * @param {{spans_total: number, by_test?: TestTraceRow[]}} f
 */
export function Trace({ spans_total, by_test = [] }) {
  return { spans_total, by_test };
}

/** The top-level run.json artifact. */
export function RunArtifact({
  schema_version,
  suite_type,
  generated_at,
  trace,
}) {
  return { schema_version, suite_type, generated_at, trace };
}

/**
 * Mirror of the Python `RunArtifact.to_dict()` (a plain `asdict()`). Because
 * the factories already build plain nested objects in field order, this is an
 * identity function -- kept for API parity with the Python contract.
 */
export function toDict(artifact) {
  return artifact;
}
