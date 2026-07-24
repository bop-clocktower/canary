// span_reader -- merge/correlate OTel span JSONL files into a Trace (pure,
// read-only). Ported from Python span_reader.py, behavior-for-behavior.
//
// Reads one or more `otel-spans.<worker>.jsonl` files (one JSON span object
// per line, written by otel_bootstrap/instrument.mjs), groups spans by
// `traceId`, resolves each trace's root span (the one carrying a `test.id`
// attribute -- set by otel_bootstrap/playwright-fixture.ts's root-span
// fixture), and attaches that trace's HTTP child spans to the resolved test.
// Traces with no `test.id`-attributed root bucket their HTTP spans under the
// synthetic test id "__setup__" (traffic outside any test, e.g. global setup).
//
// Assumed span envelope: {traceId, spanId, parentSpanId, name, startTime,
// duration_ms, attributes{}} -- matches exactly what instrument.mjs's
// JsonlFileSpanExporter writes; no `endTime` key is emitted (duration_ms +
// startTime cover it). HTTP attributes keyed http.method/http.request.method,
// http.url, http.route, http.status_code.

import fs from 'node:fs';
import path from 'node:path';

import { RequestSpan, TestTrace, Trace } from './run_types.mjs';

const SETUP_TEST_ID = '__setup__';

// Mirrors Python's Path.glob("otel-spans.*.jsonl"): the `*` matches any run of
// characters (including none) within a single path segment.
const SPAN_FILE_RE = /^otel-spans\..*\.jsonl$/;

/**
 * Read every `otel-spans.*.jsonl` file under `spansDir`, correlate spans to
 * their test roots, and return the Trace. A missing or non-directory path
 * yields an empty trace (never throws) -- the same as the Python version.
 * @param {string} spansDir
 */
export function readTraces(spansDir) {
  const byTrace = new Map();

  if (isDir(spansDir)) {
    const files = fs
      .readdirSync(spansDir)
      .filter((name) => SPAN_FILE_RE.test(name))
      .sort();
    for (const name of files) {
      for (const span of readJsonl(path.join(spansDir, name))) {
        const traceId = span.traceId;
        if (!traceId) continue;
        if (!byTrace.has(traceId)) byTrace.set(traceId, []);
        byTrace.get(traceId).push(span);
      }
    }
  }

  const byTest = [];
  const setupRequests = [];
  let spansTotal = 0;

  for (const [traceId, spans] of byTrace) {
    const root = spans.find(isTestRoot) ?? null;
    const httpSpans = spans.filter((s) => s !== root && isHttpSpan(s));
    const requests = httpSpans.map(toRequestSpan);
    spansTotal += requests.length;

    if (root === null) {
      setupRequests.push(...requests);
      continue;
    }

    const attrs = root.attributes ?? {};
    byTest.push(
      TestTrace({
        test_id: attrs['test.id'] ?? '',
        test_title: attrs['test.title'] ?? '',
        test_file: attrs['test.file'] ?? '',
        trace_id: traceId,
        outcome: attrs['test.outcome'] ?? '',
        requests,
      }),
    );
  }

  if (setupRequests.length) {
    byTest.push(
      TestTrace({
        test_id: SETUP_TEST_ID,
        test_title: '',
        test_file: '',
        trace_id: '',
        outcome: '',
        requests: setupRequests,
      }),
    );
  }

  return Trace({ spans_total: spansTotal, by_test: byTest });
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonl(filePath) {
  const spans = [];
  // NDJSON records are \n- or \r\n-delimited. We intentionally do NOT split on
  // the exotic Unicode line separators that Python's str.splitlines() also
  // breaks on (U+2028, U+2029, U+0085, ...): instrument.mjs writes those RAW
  // inside JSON string values, so splitting on them would fragment a valid
  // record and misattribute its request to __setup__.
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r\n|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      spans.push(JSON.parse(line));
    } catch {
      continue; // malformed/torn line (e.g. a crashed worker's last write)
    }
  }
  return spans;
}

function isTestRoot(span) {
  return 'test.id' in (span.attributes ?? {});
}

function isHttpSpan(span) {
  const attrs = span.attributes ?? {};
  return 'http.method' in attrs || 'http.request.method' in attrs;
}

function toRequestSpan(span) {
  const attrs = span.attributes ?? {};
  const method = attrs['http.method'] || attrs['http.request.method'] || '';
  return RequestSpan({
    method,
    url: attrs['http.url'] ?? '',
    route: attrs['http.route'] ?? null,
    status: attrs['http.status_code'] ?? null,
    duration_ms: span.duration_ms ?? 0,
    span_id: span.spanId ?? '',
    started_at: span.startTime ?? '',
  });
}
