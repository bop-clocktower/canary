/**
 * `canary testtracker push-perf` (#1580): usage, the body on the wire,
 * refusals and exit codes. Shared harness: ./testtracker-harness.js. The k6
 * mapping itself is tested in testtracker-perf-k6.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PUSH_ENV, K6_FIXTURES, runCli, pushPerf, tempReport } = require('./testtracker-harness.js');

const SUMMARY = path.join(K6_FIXTURES, 'read-slo.json');
const base = ['push-perf', '--k6-summary', SUMMARY];

// --- usage (exit 2) -----------------------------------------------------------------

test('exit 2 and nothing sent without a client, a suite or an environment', async () => {
  const cases = [
    [...base, '--suite', 's', '--env', 'e'],
    [...base, '--client', 'c', '--env', 'e'],
    [...base, '--client', 'c', '--suite', 's'],
    ['push-perf', '--client', 'c', '--suite', 's', '--env', 'e'],
  ];
  for (const args of cases) {
    const { code, requests, err } = await runCli(args);
    assert.equal(code, 2, args.join(' '));
    assert.equal(requests.length, 0);
    assert.match(err, /usage: canary testtracker push-perf/);
  }
});

test('--suite has no env fallback; --client and --env do', async () => {
  const env = { ...PUSH_ENV, CANARY_INGEST_SUITE: 'unit', CANARY_INGEST_CLIENT: 'acme', CANARY_INGEST_ENVIRONMENT: 'staging' };
  assert.equal((await runCli(base, { env })).code, 2);
  const ok = await runCli([...base, '--suite', 'checkout-load'], {
    env,
    responses: [{ status: 200, json: { reportId: 3, duplicate: false } }],
  });
  assert.equal(ok.code, 0);
  assert.equal(ok.pushes[0].url, 'https://dash.example/api/v1/tenants/acme/perf-reports');
  assert.equal(ok.payload.environment, 'staging');
});

test('a suite or environment the server would refuse is a usage error, not a failed push', async () => {
  for (const extra of [['--suite', 'Checkout Load'], ['--env', 'Prod'], ['--env', 'x'.repeat(41)], ['--generated-at', 'yesterday']]) {
    const { code, requests } = await pushPerf(SUMMARY, extra);
    assert.equal(code, 2, extra.join(' '));
    assert.equal(requests.length, 0);
  }
});

test('unknown options and flags without values are usage errors', async () => {
  assert.equal((await pushPerf(SUMMARY, ['--junit', 'x.xml'])).code, 2);
  assert.equal((await runCli([...base, '--client'])).code, 2);
});

test('pushing needs CANARY_INGEST_URL and CANARY_INGEST_TOKEN', async () => {
  const { code, requests, err } = await pushPerf(SUMMARY, [], { env: {} });
  assert.equal(code, 2);
  assert.equal(requests.length, 0);
  assert.match(err, /CANARY_INGEST_URL and CANARY_INGEST_TOKEN/);
});

test('--help prints the push-perf usage and exits 0', async () => {
  const { code, out } = await runCli(['push-perf', '--help']);
  assert.equal(code, 0);
  assert.match(out, /--k6-summary <file>/);
});

// --- the body -------------------------------------------------------------------------

const CI_ENV = {
  ...PUSH_ENV,
  GITHUB_SHA: 'abc1234def',
  GITHUB_REF_NAME: 'main',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/shop',
};

test('--dry-run prints the target and the body, sends nothing, needs no URL or token', async () => {
  const { code, out, requests } = await pushPerf(SUMMARY, ['--dry-run'], { env: {} });
  assert.equal(code, 0);
  assert.equal(requests.length, 0);
  assert.match(out, /POST \/api\/v1\/tenants\/acme\/perf-reports/);
  const body = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(body.objectives.length, 105);
  assert.match(body.runRef, /^local-[0-9a-f-]{36}$/);
});

test('the body carries exactly the fields TestTracker accepts, camelCase', async () => {
  const { payload } = await pushPerf(SUMMARY, [], { env: CI_ENV });
  assert.deepEqual(Object.keys(payload).sort(), [
    'environment', 'generatedAt', 'gitBranch', 'gitSha', 'headline', 'objectives', 'runRef', 'runUrl', 'suite',
  ]);
  assert.equal(payload.suite, 'checkout-load');
  assert.equal(payload.environment, 'staging');
  assert.equal(payload.runRef, '42-1');
  assert.equal(payload.gitSha, 'abc1234def');
  assert.equal(payload.gitBranch, 'main');
  assert.equal(payload.runUrl, 'https://github.com/acme/shop/actions/runs/42');
  assert.equal(payload.headline.httpReqs, 2812);
});

test('unknown provenance is omitted, never null (the server would 400 on null)', async () => {
  const { payload } = await pushPerf(SUMMARY, [], { env: PUSH_ENV });
  for (const k of ['gitSha', 'gitBranch', 'runUrl']) assert.equal(k in payload, false, k);
  const plainHttp = await pushPerf(SUMMARY, [], { env: { ...CI_ENV, GITHUB_SERVER_URL: 'http://ghe.local' } });
  assert.equal('runUrl' in plainHttp.payload, false);
});

test('generatedAt is --generated-at when given, else the file mtime', async () => {
  const given = await pushPerf(SUMMARY, ['--generated-at', '2026-11-04T04:13:20+00:00']);
  assert.equal(given.payload.generatedAt, '2026-11-04T04:13:20.000Z');
  const mtime = await pushPerf(SUMMARY);
  assert.equal(mtime.payload.generatedAt, require('node:fs').statSync(SUMMARY).mtime.toISOString());
});

test('--run-ref overrides the CI default', async () => {
  const { payload } = await pushPerf(SUMMARY, ['--run-ref', 'nightly-7']);
  assert.equal(payload.runRef, 'nightly-7');
});

test('the token is never printed', async () => {
  const env = { ...PUSH_ENV, CANARY_INGEST_TOKEN: 'tt_secret_canary_value' };
  for (const extra of [[], ['--dry-run']]) {
    const { out, err, logs } = await pushPerf(SUMMARY, extra, { env });
    assert.doesNotMatch(out + err + logs.join('\n'), /tt_secret_canary_value/);
  }
});

// The failure paths print the most (the server's text, the hint, the retry
// count), and in CI they also raise a GitHub annotation, so each is checked
// with annotations on.
test('the token is never printed on a refusal, a server error or a network failure', async () => {
  const env = { ...PUSH_ENV, CANARY_INGEST_TOKEN: 'tt_secret_canary_value', GITHUB_ACTIONS: 'true' };
  const refused = (status) => [{ status, json: { code: 'X', message: 'server says why' } }];
  const thrice = (r) => [r, r, r];
  const cases = {
    401: refused(401),
    404: refused(404),
    413: refused(413),
    422: refused(422),
    '503 retried to exhaustion': thrice({ status: 503, json: { code: 'INTERNAL_SERVER_ERROR' } }),
    'network error': thrice({ networkError: 'fetch failed: connect ECONNREFUSED' }),
  };
  for (const [name, responses] of Object.entries(cases)) {
    const { code, out, err, logs } = await pushPerf(SUMMARY, [], { env, responses });
    assert.equal(code, 1, name);
    const printed = out + err + logs.join('\n');
    assert.match(printed, /perf report (rejected|not ingested)/, `${name}: the failure was reported`);
    assert.doesNotMatch(printed, /tt_secret_canary_value/, name);
  }
});

// --- refusals: nothing is sent ------------------------------------------------------

const summaryFile = (data) => tempReport(JSON.stringify(data));
const metric = (values, thresholds) => ({ type: 'trend', values, ...(thresholds ? { thresholds } : {}) });

test('SC14a: no metrics, or 0 requests and 0 iterations, abstains with exit 3', async () => {
  for (const data of [
    { metrics: {} },
    { metrics: { http_reqs: { type: 'counter', values: { count: 0, rate: 0 } }, iterations: { type: 'counter', values: { count: 0 } } } },
  ]) {
    const { code, requests, err, out } = await pushPerf(summaryFile(data));
    assert.equal(code, 3);
    assert.equal(requests.length, 0);
    assert.match(err, /abstained[\s\S]*nothing was pushed/i);
    assert.doesNotMatch(out, /ingested/);
  }
});

test('SC14c: a missing, non-JSON or --summary-export file exits 1 and sends nothing', async () => {
  for (const file of [path.join(K6_FIXTURES, 'nope.json'), tempReport('<xml/>'), summaryFile({ metrics: { http_reqs: { count: 1 } } })]) {
    const { code, requests, err } = await pushPerf(file);
    assert.equal(code, 1, file);
    assert.equal(requests.length, 0);
    assert.match(err, /Nothing was pushed/);
  }
});

test('more than 2,000 thresholds exits 1 rather than truncating; exactly 2,000 is sent', async () => {
  const many = (n) => {
    const metrics = { iterations: { type: 'counter', values: { count: 1 } } };
    for (let i = 0; i < n; i++) metrics[`http_req_duration{name:r${i}}`] = metric({ 'p(99)': 1 }, { 'p(99)<5': { ok: true } });
    return summaryFile({ metrics });
  };
  const over = await pushPerf(many(2001));
  assert.equal(over.code, 1);
  assert.equal(over.requests.length, 0);
  assert.match(over.err, /2001 thresholds[\s\S]*2,000/);
  const atLimit = await pushPerf(many(2000));
  assert.equal(atLimit.code, 0);
  assert.equal(atLimit.payload.objectives.length, 2000);
});

// Within the server's own field limits (submetric ≤ 500, expression ≤ 200),
// 2,000 objectives stay near 1.5 MB, so only over-long strings can pass 2 MiB.
// The check exists so that case is refused here, not misread from a 413.
test('a body over 2 MiB exits 1 and sends nothing', async () => {
  const metrics = { iterations: { type: 'counter', values: { count: 1 } } };
  for (let i = 0; i < 2000; i++) metrics[`m{name:${'x'.repeat(1100)}${i}}`] = metric({ avg: 1 }, { [`avg<${i}`]: { ok: true } });
  const { code, requests, err } = await pushPerf(summaryFile({ metrics }));
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err, /over TestTracker's 2 MiB limit/);
});

// --- the push and its outcome ---------------------------------------------------------

test('posts to <origin>/api/v1/tenants/<client>/perf-reports with the bearer token', async () => {
  const env = { ...PUSH_ENV, CANARY_INGEST_URL: 'https://dash.example/some/path/' };
  const { code, pushes, logs } = await pushPerf(SUMMARY, [], { env });
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, 'https://dash.example/api/v1/tenants/acme/perf-reports');
  assert.match(logs.join('\n'), /canary ingest: perf report 11 ingested\./);
});

test('a duplicate exits 0 and says this push stored nothing', async () => {
  const { code, logs } = await pushPerf(SUMMARY, [], { responses: [{ status: 200, json: { reportId: 9, duplicate: true } }] });
  assert.equal(code, 0);
  assert.match(logs.join('\n'), /canary ingest: perf report 9 already ingested \(duplicate re-push of run 42-1\); this push stored nothing\./);
});

test('a 200 without a reportId cannot be confirmed: exit 1', async () => {
  const { code, logs } = await pushPerf(SUMMARY, [], { responses: [{ status: 200, json: { ok: true } }] });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /cannot confirm/);
});

test('4xx is not retried, exits 1, and names the likely cause', async () => {
  const cases = {
    400: /schema/,
    401: /unknown, revoked or expired, or not a tt_ ingest token/,
    403: /ingest:runs/,
    404: /not this token's client/,
    413: /2 MB/,
    422: /refused the content/,
  };
  for (const [status, hint] of Object.entries(cases)) {
    const { code, pushes, logs } = await pushPerf(SUMMARY, [], {
      responses: [{ status: Number(status), json: { code: 'X', message: 'server says why' } }],
    });
    assert.equal(code, 1, status);
    assert.equal(pushes.length, 1, `${status} must not be retried`);
    const text = logs.join('\n');
    assert.match(text, hint, status);
    assert.match(text, /server says why/);
    assert.doesNotMatch(text, /ingested\./);
  }
});

test('429 and 5xx are retried; success on a retry exits 0', async () => {
  const { code, pushes } = await pushPerf(SUMMARY, [], {
    responses: [{ status: 429, json: {} }, { status: 502, json: {} }, { status: 200, json: { reportId: 4, duplicate: false } }],
  });
  assert.equal(code, 0);
  assert.equal(pushes.length, 3);
});

test('still failing after the retries exits 1', async () => {
  const { code, pushes, logs } = await pushPerf(SUMMARY, [], {
    responses: [{ status: 503 }, { status: 503 }, { status: 503 }],
  });
  assert.equal(code, 1);
  assert.equal(pushes.length, 3);
  assert.match(logs.join('\n'), /not ingested after 3 attempts/);
});

// --- SC13 on the wire ------------------------------------------------------------------

test('SC13: the real nightly fixture reaches the wire as per-route p(50)/p(99) latency and rate objectives', async () => {
  const { code, payload, out } = await pushPerf(SUMMARY);
  assert.equal(code, 0);
  assert.match(out, /read 105 thresholds on 70 sub-metrics/);
  const routes = new Set(payload.objectives.map((o) => /\{name:([^}]+)\}$/.exec(o.submetric)?.[1]));
  assert.equal(routes.size, 35);
  for (const route of routes) {
    const exprs = payload.objectives
      .filter((o) => o.submetric.endsWith(`{name:${route}}`))
      .map((o) => `${o.submetric.split('{')[0]} ${o.expression.replace(/[\d.]+$/, 'N')}`)
      .sort();
    assert.deepEqual(exprs, ['dag_errors rate<N', 'http_req_duration p(50)<N', 'http_req_duration p(99)<N'], route);
  }
});
