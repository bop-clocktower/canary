/**
 * `canary testtracker push` (#1320): the four JUnit dialects, test identity,
 * status, errors and retries. Shared harness: ./testtracker-harness.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  PUSH_ENV,
  fixture,
  tempReport,
  push,
  row,
} = require('./testtracker-harness.js');

// --- one adapter, four dialects ---------------------------------------------

test('vitest: file > describe > title, failure, skipped, inline @tag', async () => {
  const { code, payload, pushes } = await push([fixture('vitest.xml')]);
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, 'https://dash.example/api/ingest/runs');
  assert.equal(payload.suite, 'unit');
  assert.equal(payload.canary_run_id, '42-1');
  assert.deepEqual(payload.totals, {
    passed: 3,
    failed: 2,
    flaky: 0,
    skipped: 1,
    total: 6,
  });
  const adds = row(payload, 'tests/cart/math.test.ts > math > adds');
  assert.equal(adds.test_file, 'tests/cart/math.test.ts');
  assert.equal(adds.status, 'passed');
  assert.equal(adds.duration_ms, 1);
  assert.equal(adds.retries, 0);
  assert.equal(
    row(payload, 'tests/cart/math.test.ts > math > skipped one').status,
    'skipped',
  );
  assert.deepEqual(
    row(payload, 'tests/cart/math.test.ts > math > checkout @smoke').tags,
    ['smoke'],
  );
  assert.equal(payload.started_at, '2026-10-01T10:00:00.000Z');
  assert.equal(payload.status, 'failed');
});

test('node --test: describe > title, todo/skip reasons, no file in the report', async () => {
  const { code, payload } = await push([fixture('node-test.xml')]);
  assert.equal(code, 0);
  const fails = row(payload, 'math > fails & <breaks>');
  assert.equal(fails.status, 'failed');
  assert.equal(fails.error_message, 'one is not two');
  assert.match(fails.error_stack, /ERR_TEST_FAILURE/);
  // node writes message="true" for a bare skip: that is not a reason.
  assert.deepEqual(row(payload, 'math > skipped one').tags, []);
  assert.deepEqual(row(payload, 'math > later').tags, [
    'todo',
    'reason:waiting on #12',
  ]);
  // No file attribute: test_file names the report it came from.
  assert.equal(
    row(payload, 'math > adds').test_file,
    path.relative(process.cwd(), fixture('node-test.xml')),
  );
});

test('newman: request > assertion; the collection classname is not repeated', async () => {
  const { code, payload } = await push([fixture('newman.xml')]);
  assert.equal(code, 0);
  assert.deepEqual(payload.results.map((r) => r.full_title).sort(), [
    'Orders / Create order > Status code is 200',
    'Users / Get user > Body has an id',
    'Users / Get user > Status code is 200',
  ]);
  const body = row(payload, 'Users / Get user > Body has an id');
  assert.equal(body.status, 'failed');
  assert.equal(body.error_message, 'expected undefined to be a number');
  assert.equal(body.duration_ms, 211);
});

test('maestro: one row per flow, failure text with no message attribute', async () => {
  const { code, payload } = await push([fixture('maestro.xml')]);
  assert.equal(code, 0);
  assert.equal(row(payload, 'Test Suite > login_flow').status, 'passed');
  const checkout = row(payload, 'Test Suite > checkout_flow');
  assert.equal(checkout.status, 'failed');
  assert.equal(
    checkout.error_message,
    'Element not found: Text matching regex: Pay',
  );
  assert.equal(checkout.duration_ms, 21500);
});

test('several reports, one run: every runner lands in a single payload', async () => {
  const { code, payload } = await push([
    fixture('vitest.xml'),
    fixture('maestro.xml'),
  ]);
  assert.equal(code, 0);
  assert.equal(payload.totals.total, 8);
});

// --- identity: the TCM join key ---------------------------------------------

test('the same test name in two files stays two rows (#1294 cross-file collapse)', async () => {
  const { payload } = await push([fixture('vitest.xml')]);
  const a = row(payload, 'tests/cart/math.test.ts > shared name');
  const b = row(payload, 'tests/search/other.test.ts > shared name');
  assert.equal(a.status, 'passed');
  assert.equal(
    b.status,
    'failed',
    'the failure in the other file must not be folded into a pass or a flaky row',
  );
});

test('a report with no file to tell same-named tests apart numbers them and says so', async () => {
  const { payload, out } = await push([fixture('node-test.xml')]);
  assert.ok(row(payload, 'shared name'));
  assert.ok(row(payload, 'shared name [2]'));
  assert.equal(payload.totals.total, 6, 'both tests count in the denominator');
  assert.match(out, /1 testcase.*numbered/);
});

// --- status, errors, retries ------------------------------------------------

test('a failed testcase carries error_message and error_stack', async () => {
  const { payload } = await push([fixture('vitest.xml')]);
  const r = row(payload, 'tests/cart/math.test.ts > math > rounds & <clamps>');
  assert.equal(r.status, 'failed');
  assert.equal(r.error_message, 'expected 1 to be 2 // Object.is equality');
  assert.match(r.error_stack, /math\.test\.ts:4:42/);
});

test('skipped maps to skipped, counted in totals and not as a failure', async () => {
  const { payload } = await push([fixture('node-test.xml')]);
  assert.equal(row(payload, 'math > skipped one').status, 'skipped');
  assert.equal(row(payload, 'math > later').status, 'skipped');
  assert.equal(payload.totals.skipped, 2);
  assert.equal(payload.totals.failed, 1);
});

test('rerun / flaky markers map to retries and flaky', async () => {
  const file = tempReport(
    '<testsuites><testsuite name="s">' +
      '<testcase classname="pkg.Recovered" name="t"><flakyFailure message="first try"/><flakyFailure message="second"/></testcase>' +
      '<testcase classname="pkg.Hopeless" name="t"><rerunFailure message="a"/><failure message="final"/></testcase>' +
      '</testsuite></testsuites>',
  );
  const { payload } = await push([file]);
  const recovered = row(payload, 's > pkg.Recovered > t');
  assert.equal(recovered.status, 'flaky');
  assert.equal(recovered.retries, 2);
  assert.equal(recovered.error_message, 'first try');
  const hopeless = row(payload, 's > pkg.Hopeless > t');
  assert.equal(hopeless.status, 'failed');
  assert.equal(hopeless.retries, 1);
  assert.equal(hopeless.error_message, 'final');
  assert.equal(payload.status, 'failed');
});

test('the area map applies to the test file (#1183)', async () => {
  const { payload } = await push([fixture('vitest.xml')], [], {
    env: { ...PUSH_ENV, CANARY_INGEST_AREA_MAP: '{"tests/cart/**":"cart"}' },
  });
  assert.equal(
    row(payload, 'tests/cart/math.test.ts > math > adds').area,
    'cart',
  );
  assert.equal(
    row(payload, 'tests/search/other.test.ts > shared name').area,
    undefined,
  );
});
