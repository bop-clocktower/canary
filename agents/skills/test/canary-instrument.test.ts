// Unit suite for the canary-instrument skill, ported from Python to vitest as
// the skill moves to JS (canary mirrors harness, which is TS/Node). Behavior is
// preserved from the Python version, including the run.json v1 contract shape.
//
// canary-instrument correlates a Playwright run's tests to their outbound HTTP
// spans: it reads OTel span JSONL, resolves each test's root span, attaches
// HTTP child spans, and writes a trace-only run.json artifact.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as runTypes from '../claude-code/canary-instrument/scripts/run_types.mjs';
import { readTraces } from '../claude-code/canary-instrument/scripts/span_reader.mjs';
import { main } from '../claude-code/canary-instrument/scripts/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, '..', 'claude-code', 'canary-instrument');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'instrument-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// --- span fixtures (mirror the Python test's _span/_root_span/_http_span) ----

type Attrs = Record<string, unknown>;
type Span = Record<string, unknown>;

const span = (
  traceId: string,
  spanId: string,
  attrs: Attrs = {},
  duration_ms = 1.0,
): Span => ({
  traceId,
  spanId,
  parentSpanId: null,
  name: 'span',
  startTime: '2026-07-15T18:00:01+00:00',
  endTime: '2026-07-15T18:00:01+00:00',
  duration_ms,
  attributes: attrs,
});

const rootSpan = (
  traceId: string,
  spanId: string,
  o: { test_id: string; title: string; file: string; outcome?: string },
): Span =>
  span(traceId, spanId, {
    'test.id': o.test_id,
    'test.title': o.title,
    'test.file': o.file,
    'test.outcome': o.outcome ?? 'passed',
  });

const httpSpan = (
  traceId: string,
  spanId: string,
  o: {
    method?: string;
    url?: string;
    route?: string;
    status?: number;
    duration_ms?: number;
  } = {},
): Span =>
  span(
    traceId,
    spanId,
    {
      'http.method': o.method ?? 'GET',
      'http.url': o.url ?? 'http://x/1',
      'http.route': o.route ?? '/x/:id',
      'http.status_code': o.status ?? 200,
    },
    o.duration_ms ?? 12.4,
  );

const writeJsonl = (filePath: string, spans: Span[]) =>
  fs.writeFileSync(
    filePath,
    spans.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8',
  );

// --- run_types: the v1 contract shape --------------------------------------

describe('run_types', () => {
  it('RunArtifact has no coverage or canary_run_id keys', () => {
    const artifact = runTypes.RunArtifact({
      schema_version: 1,
      suite_type: 'e2e_ui',
      generated_at: '2026-07-15T18:00:00+00:00',
      trace: runTypes.Trace({ spans_total: 0, by_test: [] }),
    });
    const d = runTypes.toDict(artifact);
    expect('coverage' in d).toBe(false);
    expect('canary_run_id' in d).toBe(false);
    expect(d.schema_version).toBe(1);
    expect(d.suite_type).toBe('e2e_ui');
  });

  it('serializes nested requests field-for-field', () => {
    const req = runTypes.RequestSpan({
      method: 'GET',
      url: 'http://localhost:3000/users/1',
      route: '/users/:id',
      status: 200,
      duration_ms: 12.4,
      span_id: 'def456',
      started_at: '2026-07-15T18:00:01+00:00',
    });
    const tt = runTypes.TestTrace({
      test_id: 'users-spec:1',
      test_title: 'lists users',
      test_file: 'tests/users.spec.ts',
      trace_id: 'abc123',
      outcome: 'passed',
      requests: [req],
    });
    const d = runTypes.toDict(
      runTypes.RunArtifact({
        schema_version: 1,
        suite_type: '',
        generated_at: '2026-07-15T18:00:00+00:00',
        trace: runTypes.Trace({ spans_total: 1, by_test: [tt] }),
      }),
    );
    expect(d.trace.spans_total).toBe(1);
    const row = d.trace.by_test[0];
    expect(row.test_id).toBe('users-spec:1');
    expect(row.outcome).toBe('passed');
    expect(row.requests[0].method).toBe('GET');
    expect(row.requests[0].status).toBe(200);
  });

  it('is JSON serializable (round-trips cleanly)', () => {
    const d = runTypes.toDict(
      runTypes.RunArtifact({
        schema_version: 1,
        suite_type: 'api',
        generated_at: '2026-07-15T18:00:00+00:00',
        trace: runTypes.Trace({ spans_total: 0, by_test: [] }),
      }),
    );
    expect(JSON.parse(JSON.stringify(d)).suite_type).toBe('api');
  });

  it('TestTrace.requests defaults to a fresh empty list', () => {
    const tt = runTypes.TestTrace({
      test_id: '__setup__',
      test_title: '',
      test_file: '',
      trace_id: '',
      outcome: '',
    });
    expect(tt.requests).toEqual([]);
    // fresh per-call, not a shared mutable default
    const other = runTypes.TestTrace({
      test_id: 'x',
      test_title: '',
      test_file: '',
      trace_id: '',
      outcome: '',
    });
    expect(other.requests).not.toBe(tt.requests);
  });

  it('Trace.by_test defaults to an empty list', () => {
    expect(runTypes.Trace({ spans_total: 0 }).by_test).toEqual([]);
  });

  it('preserves the exact field order of the dataclass contract', () => {
    const d = runTypes.RunArtifact({
      schema_version: 1,
      suite_type: '',
      generated_at: 'ts',
      trace: runTypes.Trace({
        spans_total: 1,
        by_test: [
          runTypes.TestTrace({
            test_id: 'a:1',
            test_title: 't',
            test_file: 'f',
            trace_id: 'tid',
            outcome: 'passed',
            requests: [
              runTypes.RequestSpan({
                method: 'GET',
                url: 'u',
                route: null,
                status: null,
                duration_ms: 1,
                span_id: 's',
                started_at: 'st',
              }),
            ],
          }),
        ],
      }),
    });
    expect(Object.keys(d)).toEqual([
      'schema_version',
      'suite_type',
      'generated_at',
      'trace',
    ]);
    expect(Object.keys(d.trace)).toEqual(['spans_total', 'by_test']);
    expect(Object.keys(d.trace.by_test[0])).toEqual([
      'test_id',
      'test_title',
      'test_file',
      'trace_id',
      'outcome',
      'requests',
    ]);
    expect(Object.keys(d.trace.by_test[0].requests[0])).toEqual([
      'method',
      'url',
      'route',
      'status',
      'duration_ms',
      'span_id',
      'started_at',
    ]);
  });
});

// --- span_reader: correlation ----------------------------------------------

describe('span_reader.readTraces', () => {
  it('missing spans dir returns an empty trace', () => {
    const trace = readTraces(path.join(mkTmp(), 'does-not-exist'));
    expect(trace.spans_total).toBe(0);
    expect(trace.by_test).toEqual([]);
  });

  it('empty spans dir returns an empty trace', () => {
    const trace = readTraces(mkTmp()); // exists, no *.jsonl files
    expect(trace.spans_total).toBe(0);
    expect(trace.by_test).toEqual([]);
  });

  it('attaches an http child to its test root', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'users-spec:1',
        title: 'lists users',
        file: 'tests/users.spec.ts',
      }),
      httpSpan('t1', 's2'),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(1);
    expect(trace.by_test.length).toBe(1);
    const tt = trace.by_test[0];
    expect(tt.test_id).toBe('users-spec:1');
    expect(tt.outcome).toBe('passed');
    expect(tt.requests.length).toBe(1);
    expect(tt.requests[0].method).toBe('GET');
    expect(tt.requests[0].status).toBe(200);
  });

  it('buckets a rootless trace under __setup__', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      httpSpan('t2', 's1', { url: 'http://x/health' }),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(1);
    expect(trace.by_test.length).toBe(1);
    expect(trace.by_test[0].test_id).toBe('__setup__');
    expect(trace.by_test[0].requests[0].url).toBe('http://x/health');
  });

  it('does not count the root span itself as a request', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(0);
    expect(trace.by_test[0].requests).toEqual([]);
  });

  it('merges multi-worker files without spanId collision', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'test a',
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2', { url: 'http://x/a' }),
    ]);
    writeJsonl(path.join(tmp, 'otel-spans.1.jsonl'), [
      rootSpan('t2', 's1', {
        test_id: 'b:1',
        title: 'test b',
        file: 'b.spec.ts',
      }),
      httpSpan('t2', 's2', { url: 'http://x/b' }),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(2);
    expect(new Set(trace.by_test.map((t) => t.test_id))).toEqual(
      new Set(['a:1', 'b:1']),
    );
    const urls = new Set(
      trace.by_test.flatMap((t) => t.requests.map((r) => r.url)),
    );
    expect(urls).toEqual(new Set(['http://x/a', 'http://x/b']));
  });

  it('reconciles counts across setup and test buckets', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'test a',
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2'),
      httpSpan('t1', 's3'),
      httpSpan('t3', 's1'), // rootless -> __setup__
    ]);
    const trace = readTraces(tmp);
    const totalRequests = trace.by_test.reduce(
      (n, t) => n + t.requests.length,
      0,
    );
    expect(trace.spans_total).toBe(3);
    expect(totalRequests).toBe(3);
    const setup = trace.by_test.find((t) => t.test_id === '__setup__')!;
    expect(setup.requests.length).toBe(1);
  });

  it('skips a malformed/torn line without raising', () => {
    const tmp = mkTmp();
    const p = path.join(tmp, 'otel-spans.0.jsonl');
    const good = [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'test a',
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2'),
    ];
    let text = good.map((s) => JSON.stringify(s)).join('\n') + '\n';
    text += '{"traceId": "t1", "spanId": "s3", "attributes": {"http.method"'; // torn
    fs.writeFileSync(p, text, 'utf8');
    const trace = readTraces(tmp); // must not raise
    expect(trace.spans_total).toBe(1);
    expect(trace.by_test[0].test_id).toBe('a:1');
  });

  it('ignores blank lines between spans', () => {
    const tmp = mkTmp();
    const p = path.join(tmp, 'otel-spans.0.jsonl');
    const spans = [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      httpSpan('t1', 's2'),
    ];
    fs.writeFileSync(
      p,
      spans.map((s) => JSON.stringify(s)).join('\n\n') + '\n\n',
      'utf8',
    );
    expect(readTraces(tmp).spans_total).toBe(1);
  });

  it('skips spans without a traceId', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      { spanId: 's0', attributes: { 'http.method': 'GET' } }, // no traceId
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      httpSpan('t1', 's2'),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(1);
    expect(trace.by_test.length).toBe(1);
    expect(trace.by_test[0].test_id).toBe('a:1');
  });

  it('recognizes http.request.method and falls back for missing fields', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      // only http.request.method; no url/route/status -> defaults + nulls
      span('t1', 's2', { 'http.request.method': 'POST' }, 5),
    ]);
    const trace = readTraces(tmp);
    const req = trace.by_test[0].requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('');
    expect(req.route).toBeNull();
    expect(req.status).toBeNull();
    expect(req.duration_ms).toBe(5);
  });

  // The attributes below are what `@opentelemetry/auto-instrumentations-node`
  // ACTUALLY emits — captured from a real Playwright run through
  // otel_bootstrap/instrument.mjs. No `http.url` and no `http.status_code`
  // appear anywhere in that set, which is why reading only the old names
  // produced a full span count with `url: ""` on every request.
  it('reconstructs the URL from split current-convention attributes', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span(
        't1',
        's2',
        {
          'http.request.method': 'GET',
          'url.scheme': 'http',
          'server.address': '127.0.0.1',
          'server.port': 62346,
          'url.path': '/v1/probe/via-request-fixture',
          'http.response.status_code': 200,
        },
        5,
      ),
    ]);
    const req = readTraces(tmp).by_test[0].requests[0];
    expect(req.url).toBe('http://127.0.0.1:62346/v1/probe/via-request-fixture');
    expect(req.status).toBe(200);
  });

  it('omits the port when it is the scheme default, matching a spec path', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span('t1', 's2', {
        'http.request.method': 'GET',
        'url.scheme': 'https',
        'server.address': 'api.example.com',
        'server.port': 443,
        'url.path': '/v1/members',
      }),
    ]);
    expect(readTraces(tmp).by_test[0].requests[0].url).toBe('https://api.example.com/v1/members');
  });

  it('still reads the legacy single-attribute convention', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span('t1', 's2', {
        'http.method': 'GET',
        'http.url': 'http://legacy/v1/thing',
        'http.status_code': 204,
      }),
    ]);
    const req = readTraces(tmp).by_test[0].requests[0];
    expect(req.url).toBe('http://legacy/v1/thing');
    expect(req.status).toBe(204);
  });

  it('prefers url.full over reassembling the pieces', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span('t1', 's2', {
        'http.request.method': 'GET',
        'url.full': 'https://host/full/path?q=1',
        'url.scheme': 'https',
        'server.address': 'host',
        'url.path': '/full/path',
      }),
    ]);
    expect(readTraces(tmp).by_test[0].requests[0].url).toBe('https://host/full/path?q=1');
  });

  it('carries the query string when only the pieces are present', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span('t1', 's2', {
        'http.request.method': 'GET',
        'url.scheme': 'http',
        'server.address': 'h',
        'url.path': '/s',
        'url.query': 'page=2',
      }),
    ]);
    expect(readTraces(tmp).by_test[0].requests[0].url).toBe('http://h/s?page=2');
  });

  it('falls back to the bare path rather than an empty URL when the host is absent', () => {
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      span('t1', 's2', { 'http.request.method': 'GET', 'url.path': '/only/path' }),
    ]);
    expect(readTraces(tmp).by_test[0].requests[0].url).toBe('/only/path');
  });

  it('does not fragment a record on a raw U+2028 inside a JSON value', () => {
    // Python str.splitlines() breaks on U+2028; instrument.mjs writes such
    // separators raw inside string values. Splitting on them would tear a
    // valid NDJSON record and misattribute its request to __setup__. We split
    // only on \n / \r\n, so the record stays intact and correlates correctly.
    const tmp = mkTmp();
    writeJsonl(path.join(tmp, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'line one line two', // raw line separator inside a value
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2', { url: 'http://x/a' }),
    ]);
    const trace = readTraces(tmp);
    expect(trace.spans_total).toBe(1);
    expect(trace.by_test.length).toBe(1);
    const tt = trace.by_test[0];
    expect(tt.test_id).toBe('a:1'); // NOT __setup__
    expect(tt.test_title).toBe('line one line two');
    expect(tt.requests[0].url).toBe('http://x/a');
    expect(trace.by_test.some((t) => t.test_id === '__setup__')).toBe(false);
  });
});

// --- cli --------------------------------------------------------------------

const captureLog = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  return { out, err };
};

const readRunJson = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));

describe('cli', () => {
  // The failure this guards is not "no spans" — that is a documented, honest
  // empty trace. It is "spans captured, correlated, and every URL lost", which
  // is what an attribute-name mismatch looks like from outside and which used
  // to exit 0 announcing a written artifact.
  it('refuses to write an artifact when no correlated request carries a URL', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      // A method and nothing else: present, attributed, and unusable.
      span('t1', 's2', { 'http.request.method': 'GET' }),
    ]);
    const outDir = path.join(tmp, 'out');
    const { err } = captureLog();
    const rc = main(['--spans', spansDir, '--output', outDir]);
    expect(rc).toBe(1);
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(false);
    const text = err.join('\n');
    expect(text).toContain('NONE carried a URL');
    expect(text).toContain('semantic-convention mismatch');
  });

  it('still treats an empty spans dir as an honest empty trace, not a failure', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    const outDir = path.join(tmp, 'out');
    captureLog();
    expect(main(['--spans', spansDir, '--output', outDir])).toBe(0);
    expect(readRunJson(outDir).trace.spans_total).toBe(0);
  });

  it('reports the URL-bearing count alongside the span count', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      httpSpan('t1', 's2', { url: 'http://x/a' }),
    ]);
    const outDir = path.join(tmp, 'out');
    const { out } = captureLog();
    expect(main(['--spans', spansDir, '--output', outDir])).toBe(0);
    expect(out.join('\n')).toContain('1/1 request(s) with a URL');
  });

  it('warns on partial URL loss but still writes the artifact', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      httpSpan('t1', 's2', { url: 'http://x/a' }),
      span('t1', 's3', { 'http.request.method': 'GET' }),
    ]);
    const outDir = path.join(tmp, 'out');
    const warn: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((s?: unknown) => {
      warn.push(String(s));
    });
    captureLog();
    expect(main(['--spans', spansDir, '--output', outDir])).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(true);
    expect(warn.join('\n')).toContain('1 request(s) had no resolvable URL');
  });

  it('writes run.json with the correct shape and exits zero', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'test a',
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2'),
    ]);
    const outDir = path.join(tmp, 'out');
    captureLog();
    const rc = main([
      '--spans',
      spansDir,
      '--output',
      outDir,
      '--suite-type',
      'e2e_ui',
    ]);
    expect(rc).toBe(0);
    const runJson = readRunJson(outDir);
    expect(runJson.schema_version).toBe(1);
    expect(runJson.suite_type).toBe('e2e_ui');
    expect('coverage' in runJson).toBe(false);
    expect('canary_run_id' in runJson).toBe(false);
    expect(runJson.trace.spans_total).toBe(1);
  });

  it('creates a missing (nested) output directory', () => {
    const tmp = mkTmp();
    const outDir = path.join(tmp, 'nested', 'out');
    expect(fs.existsSync(outDir)).toBe(false);
    captureLog();
    const rc = main([
      '--spans',
      path.join(tmp, 'no-spans'),
      '--output',
      outDir,
    ]);
    expect(rc).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(true);
  });

  it('missing spans dir is not a failure (empty trace block)', () => {
    const tmp = mkTmp();
    captureLog();
    const rc = main([
      '--spans',
      path.join(tmp, 'nope'),
      '--output',
      path.join(tmp, 'out'),
    ]);
    expect(rc).toBe(0);
    expect(readRunJson(path.join(tmp, 'out')).trace).toEqual({
      spans_total: 0,
      by_test: [],
    });
  });

  it('suite_type defaults to the empty string', () => {
    const tmp = mkTmp();
    captureLog();
    main([
      '--spans',
      path.join(tmp, 'nope'),
      '--output',
      path.join(tmp, 'out'),
    ]);
    expect(readRunJson(path.join(tmp, 'out')).suite_type).toBe('');
  });

  it('suite_type accepts an arbitrary string (no enum)', () => {
    const tmp = mkTmp();
    captureLog();
    const rc = main([
      '--spans',
      path.join(tmp, 'nope'),
      '--output',
      path.join(tmp, 'out'),
      '--suite-type',
      'totally-made-up-value',
    ]);
    expect(rc).toBe(0);
    expect(readRunJson(path.join(tmp, 'out')).suite_type).toBe(
      'totally-made-up-value',
    );
  });

  it('accepts the --flag=value form', () => {
    const tmp = mkTmp();
    captureLog();
    const rc = main([
      `--spans=${path.join(tmp, 'nope')}`,
      `--output=${path.join(tmp, 'out')}`,
      '--suite-type=api',
    ]);
    expect(rc).toBe(0);
    expect(readRunJson(path.join(tmp, 'out')).suite_type).toBe('api');
  });

  it('errors (exit 1) when --spans is a file, not a directory', () => {
    const tmp = mkTmp();
    const badSpans = path.join(tmp, 'spans-is-a-file');
    fs.writeFileSync(badSpans, 'oops', 'utf8');
    const { err } = captureLog();
    const rc = main(['--spans', badSpans, '--output', path.join(tmp, 'out')]);
    expect(rc).toBe(1);
    expect(err.join('\n')).toContain('not a directory');
  });

  it('errors (exit 2) when a required flag is missing', () => {
    const { err } = captureLog();
    expect(main([])).toBe(2);
    expect(err.join('\n')).toContain('required');
  });

  it('errors (exit 2) on an unrecognized flag', () => {
    const { err } = captureLog();
    expect(main(['--spans', 'x', '--output', 'y', '--bogus'])).toBe(2);
    expect(err.join('\n')).toContain('unrecognized');
  });

  it('errors (exit 2) when --suite-type is the last token (no value)', () => {
    const tmp = mkTmp();
    const { err } = captureLog();
    const outDir = path.join(tmp, 'out');
    expect(
      main([
        '--spans',
        path.join(tmp, 'nope'),
        '--output',
        outDir,
        '--suite-type',
      ]),
    ).toBe(2);
    expect(err.join('\n')).toContain('expected one argument');
    // must NOT have silently written a suite_type-less run.json
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(false);
  });

  it('errors (exit 2) when --spans is the last token (no value)', () => {
    const { err } = captureLog();
    expect(main(['--output', 'o', '--spans'])).toBe(2);
    expect(err.join('\n')).toContain('expected one argument');
  });

  it('errors (exit 2) when a value-flag is followed by another flag', () => {
    const { err } = captureLog();
    // --spans has no value; the next token is a flag, not a value
    expect(main(['--spans', '--output', 'o'])).toBe(2);
    expect(err.join('\n')).toContain('expected one argument');
  });

  // --- --help --------------------------------------------------------------

  // The trap: --help must short-circuit BEFORE the required-argument check,
  // or a naive fix returns 2 with "the following arguments are required".
  it('--help exits zero without --spans/--output and says nothing on stderr', () => {
    const { out, err } = captureLog();
    expect(main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-instrument');
    expect(err.join('\n')).toBe('');
  });

  it('-h behaves the same as --help', () => {
    const { out, err } = captureLog();
    expect(main(['-h'])).toBe(0);
    expect(out.join('\n')).toContain('usage: canary-instrument');
    expect(err.join('\n')).toBe('');
  });

  it('usage names every option', () => {
    const { out } = captureLog();
    expect(main(['--help'])).toBe(0);
    const text = out.join('\n');
    for (const flag of ['--spans', '--output', '--suite-type']) {
      expect(text).toContain(flag);
    }
  });

  it('--help wins over a trailing unrecognized flag', () => {
    const { err } = captureLog();
    expect(main(['--help', '--bogus'])).toBe(0);
    expect(err.join('\n')).toBe('');
  });

  // The unrecognized-flag case is already covered above; what was untested is
  // that --help short-circuits ahead of the ARTIFACT WRITE, not just ahead of
  // the required-argument check. The control run proves the write is reachable
  // with this exact argv, so the assertion cannot pass vacuously.
  it('--help does not write run.json', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    const outDir = path.join(tmp, 'out');
    const argv = ['--spans', spansDir, '--output', outDir];
    captureLog();
    expect(main(argv)).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(true);
    fs.rmSync(outDir, { recursive: true });
    expect(main(['--help', ...argv])).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'run.json'))).toBe(false);
  });
});

// --- run.json byte-level contract fidelity ---------------------------------

describe('run.json byte fidelity (matches Python json.dumps)', () => {
  const writeRun = (): string => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'lists users',
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2', { url: 'http://localhost:3000/users/1' }),
    ]);
    const outDir = path.join(tmp, 'out');
    captureLog();
    main(['--spans', spansDir, '--output', outDir]);
    return path.join(outDir, 'run.json');
  };

  it('uses 2-space indent and no trailing newline', () => {
    const raw = fs.readFileSync(writeRun(), 'utf8');
    expect(raw.startsWith('{\n  "schema_version": 1,')).toBe(true);
    expect(raw.endsWith('}')).toBe(true); // no trailing newline
    expect(raw.endsWith('}\n')).toBe(false);
  });

  it('keeps status: null and route present (not omitted) when missing', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', { test_id: 'a:1', title: 'a', file: 'a.spec.ts' }),
      // Method + URL, but no route/status -> both must serialize as null.
      // The URL is required only to clear the cli's no-usable-URL abstention;
      // this test is about null serialization, and a URL-less span is now a
      // refusal rather than an artifact.
      span('t1', 's2', { 'http.method': 'GET', 'http.url': 'http://x/a' }, 3),
    ]);
    const outDir = path.join(tmp, 'out');
    captureLog();
    main(['--spans', spansDir, '--output', outDir]);
    const raw = fs.readFileSync(path.join(outDir, 'run.json'), 'utf8');
    expect(raw).toContain('"route": null');
    expect(raw).toContain('"status": null');
    // parsed shape keeps the keys (JSON.stringify would have dropped undefined)
    const req = JSON.parse(raw).trace.by_test[0].requests[0];
    expect('route' in req).toBe(true);
    expect('status' in req).toBe(true);
    expect(req.route).toBeNull();
    expect(req.status).toBeNull();
  });

  it('escapes non-ASCII as \\uXXXX (ensure_ascii parity)', () => {
    const tmp = mkTmp();
    const spansDir = path.join(tmp, 'spans');
    fs.mkdirSync(spansDir);
    writeJsonl(path.join(spansDir, 'otel-spans.0.jsonl'), [
      rootSpan('t1', 's1', {
        test_id: 'a:1',
        title: 'café', // é
        file: 'a.spec.ts',
      }),
      httpSpan('t1', 's2', { url: 'http://x/é' }),
    ]);
    const outDir = path.join(tmp, 'out');
    captureLog();
    main(['--spans', spansDir, '--output', outDir]);
    const raw = fs.readFileSync(path.join(outDir, 'run.json'), 'utf8');
    // raw file bytes carry the escape, not the literal accented char
    expect(raw).toContain('caf\\u00e9');
    expect(raw.includes('é')).toBe(false);
    // still parses back to the original string
    expect(JSON.parse(raw).trace.by_test[0].test_title).toBe('café');
  });
});

// --- skill packaging contract ----------------------------------------------

describe('packaging', () => {
  it('SKILL.md declares the executable contract (node, cli.mjs)', () => {
    const head = fs
      .readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
      .split('---')[1];
    expect(head).toContain('name: canary-instrument');
    expect(head).toContain('cli: scripts/cli.mjs');
    expect(head).toContain('node>=20');
  });

  // The skill runner spawns the `cli:` target directly (ts/src/skills-cli.ts
  // execs the file, relying on its shebang), so a cli.mjs without the exec bit
  // makes the documented `canary skills run canary-instrument -- --help` fail with no
  // output at all. Assert the bit AND a real spawn, not just the file's text.
  it('cli.mjs is executable and runs when spawned directly', () => {
    const cli = path.join(SCRIPTS, 'cli.mjs');
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
    const res = spawnSync(cli, ['--help'], { encoding: 'utf8' });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });

  it('ported scripts are ascii-only (no emoji)', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue; // top-level ports only
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
    }
  });

  it('is self-contained: no engine (agent/) imports', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      expect(text.includes('agent/') || text.includes('agent.')).toBe(false);
    }
  });

  it('the skill dir has no client strings', () => {
    // Split string literals so this file does not itself contain the
    // proprietary tokens it guards against.
    const banned = [
      'capi' + 'llary',
      'loop' + 'back',
      'op' + 'tum',
      'cap' + 'well',
    ];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full);
        } else if (['.mjs', '.md', '.ts'].includes(path.extname(full))) {
          const text = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const bad of banned) expect(text.includes(bad)).toBe(false);
        }
      }
    };
    walk(SKILL_DIR);
  });
});
