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
