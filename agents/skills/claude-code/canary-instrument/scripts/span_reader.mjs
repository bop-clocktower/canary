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

/**
 * Reconstruct the request URL across both OTel HTTP semantic conventions.
 *
 * The old convention put the whole thing in one attribute, `http.url`. The
 * current one (stable since semconv 1.23) splits it: `url.full` on some
 * instrumentations, and otherwise the pieces -- `url.scheme`, `server.address`,
 * `server.port`, `url.path`. `@opentelemetry/auto-instrumentations-node`, which
 * `otel_bootstrap/instrument.mjs` tells consumers to install, emits the SPLIT
 * form and no `http.url` at all.
 *
 * Reading only `http.url` therefore produced `url: ""` on every request while
 * the reader still reported a full span count and exit 0 -- the artifact looked
 * written and was empty of the one field a coverage consumer needs. Port is
 * omitted when it is the scheme default, so the URL matches what a spec or a
 * HAR would say.
 */
function requestUrl(attrs) {
  const direct = attrs['url.full'] ?? attrs['http.url'];
  if (direct) return direct;

  const scheme = attrs['url.scheme'] ?? attrs['http.scheme'];
  const host =
    attrs['server.address'] ?? attrs['net.peer.name'] ?? attrs['http.host'];
  const path = attrs['url.path'] ?? attrs['http.target'] ?? '';
  if (!scheme || !host) return typeof path === 'string' ? path : '';

  const port = attrs['server.port'] ?? attrs['net.peer.port'];
  const isDefaultPort =
    port == null ||
    (scheme === 'http' && +port === 80) ||
    (scheme === 'https' && +port === 443);
  const authority = isDefaultPort ? host : `${host}:${port}`;
  const query = attrs['url.query'] ? `?${attrs['url.query']}` : '';
  return `${scheme}://${authority}${path}${query}`;
}

function toRequestSpan(span) {
  const attrs = span.attributes ?? {};
  const method = attrs['http.method'] || attrs['http.request.method'] || '';
  return RequestSpan({
    method,
    url: requestUrl(attrs),
    // `http.route` is a SERVER-side attribute and is never present on the client
    // spans this reader consumes. Kept for producers that do supply it (a future
    // server-side producer under the same v1 contract), but its absence here is
    // normal, not a gap.
    route: attrs['http.route'] ?? null,
    // Renamed in the current convention. Old name kept as a fallback.
    status:
      attrs['http.response.status_code'] ?? attrs['http.status_code'] ?? null,
    duration_ms: span.duration_ms ?? 0,
    span_id: span.spanId ?? '',
    started_at: span.startTime ?? '',
  });
}
