/**
 * `canary testtracker push` (#1320): the stated denominator, refusals and
 * exit codes. Shared harness: ./testtracker-harness.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  FIXTURES,
  PUSH_ENV,
  fixture,
  tempReport,
  runCli,
  push,
} = require('./testtracker-harness.js');

// --- the denominator ---------------------------------------------------------

test('the output states the denominator: testcases read, results sent, per status', async () => {
  const { out } = await push([fixture('vitest.xml'), fixture('maestro.xml')]);
  assert.match(out, /read 8 testcases from 2 JUnit reports/);
  assert.match(out, /8 results: 4 passed, 3 failed, 0 flaky, 1 skipped/);
});

test('collected carries every testcase by default, and --no-collected leaves it out', async () => {
  const on = await push([fixture('maestro.xml')]);
  assert.deepEqual(on.payload.collected.map((c) => c.full_title).sort(), [
    'Test Suite > checkout_flow',
    'Test Suite > login_flow',
  ]);
  const off = await push([fixture('maestro.xml')], ['--no-collected']);
  assert.equal('collected' in off.payload, false);
});

// --- refusals ----------------------------------------------------------------

test('an empty report abstains: exit 3, nothing pushed, never "pushed 0"', async () => {
  const { code, pushes, err, out } = await push([
    fixture('empty.xml'),
    fixture('maestro.xml'),
  ]);
  assert.equal(code, 3);
  assert.equal(pushes.length, 0);
  assert.match(err, /empty\.xml.*0 testcases/);
  assert.match(err, /nothing was pushed/);
  assert.doesNotMatch(out, /pushed|0 results/);
});

test('a file that is not JUnit XML is refused with exit 1', async () => {
  const { code, pushes, err } = await push([tempReport('{"not":"xml"}')]);
  assert.equal(code, 1);
  assert.equal(pushes.length, 0);
  assert.match(err, /not a JUnit XML report/);
});

test('a missing report file is refused with exit 1', async () => {
  const { code, err } = await push([path.join(FIXTURES, 'nope.xml')]);
  assert.equal(code, 1);
  assert.match(err, /nope\.xml/);
});

test('a rejected push exits 1', async () => {
  const { code } = await push([fixture('maestro.xml')], [], {
    responses: [{ status: 400, json: { error: 'bad' } }],
  });
  assert.equal(code, 1);
});

test('--dry-run prints the payload and pushes nothing, no url or token needed', async () => {
  const { code, out, requests } = await push(
    [fixture('maestro.xml')],
    ['--dry-run'],
    { env: {} },
  );
  assert.equal(code, 0);
  assert.equal(requests.length, 0);
  const json = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(json.totals.total, 2);
  assert.equal(json.workflow, 'junit');
});

// --- usage errors exit 2 ------------------------------------------------------

for (const [label, args, env, pattern] of [
  ['no subcommand', [], PUSH_ENV, /usage: canary testtracker push/],
  ['an unknown subcommand', ['pull'], PUSH_ENV, /unknown subcommand 'pull'/],
  ['no --junit', ['push', '--suite', 'unit'], PUSH_ENV, /--junit/],
  [
    '--junit with no file',
    ['push', '--suite', 'unit', '--junit'],
    PUSH_ENV,
    /--junit/,
  ],
  [
    'an unknown flag',
    ['push', '--junit', 'x.xml', '--suite', 'unit', '--bogus'],
    PUSH_ENV,
    /unknown option "--bogus"/,
  ],
  ['no suite', ['push', '--junit', 'x.xml'], PUSH_ENV, /suite/],
  [
    'no url or token',
    ['push', '--junit', 'x.xml', '--suite', 'unit'],
    {},
    /CANARY_INGEST_URL and CANARY_INGEST_TOKEN/,
  ],
]) {
  test(`usage error exits 2: ${label}`, async () => {
    const { code, err, pushes } = await runCli(args, { env });
    assert.equal(code, 2);
    assert.match(err, pattern);
    assert.equal(pushes.length, 0);
  });
}

test('--help prints usage and exits 0', async () => {
  const { code, out } = await runCli(['push', '--help']);
  assert.equal(code, 0);
  assert.match(out, /--junit <file…>/);
  assert.match(out, /vitest run --reporter=junit/);
});
