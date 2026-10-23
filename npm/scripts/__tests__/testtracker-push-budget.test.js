/**
 * `canary testtracker push` over the 4 MB body budget (#1355). Fitting a big
 * run used to drop the catalog (the suite lands unmeasured), warn, and still
 * exit 0: a silent degrade on a nightly nobody watches. Under CI, or with
 * `--strict-budget`, a lossy fit is refused before anything is sent.
 * Shared harness: ./testtracker-harness.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { PUSH_ENV, tempReport, push } = require('./testtracker-harness.js');

const CI_ENV = { ...PUSH_ENV, CI: 'true' };
const LOCAL_ENV = PUSH_ENV; // no CI variable

/** A vitest-style JUnit report with `n` passing testcases. */
function bigReport(n) {
  const cases = [];
  for (let i = 0; i < n; i += 1) {
    const file = `tests/area-${i % 50}/module-${i % 400}.test.ts`;
    cases.push(
      `<testcase classname="${file}" name="behaves correctly for input case number ${i} under the default configuration" time="0.001"/>`,
    );
  }
  return tempReport(
    `<?xml version="1.0"?><testsuites><testsuite name="vitest" tests="${n}">${cases.join('')}</testsuite></testsuites>`,
  );
}

// ~10k rows: over 4 MB with the catalog, comfortably under without it.
const OVER_WITH_CATALOG = bigReport(10_000);

test('under CI, a payload that would lose its catalog is refused and nothing is sent', async () => {
  const { code, pushes, err } = await push([OVER_WITH_CATALOG], [], {
    env: CI_ENV,
  });
  assert.equal(code, 1);
  assert.equal(pushes.length, 0);
  assert.match(err, /\d{7,} bytes/); // the measured size
  assert.match(err, /4000000/); // the budget
  assert.match(err, /catalog/);
  assert.match(err, /--no-strict-budget/); // how to opt out
  assert.match(err, /Nothing was pushed/);
});

test('outside CI the default stays warn-and-push: exit 0, catalog dropped, warned', async () => {
  const { code, pushes, payload, logs } = await push([OVER_WITH_CATALOG], [], {
    env: LOCAL_ENV,
  });
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  assert.equal('collected' in payload, false);
  assert.ok(logs.some((l) => /collected was dropped/.test(l)));
});

test('--strict-budget refuses outside CI too', async () => {
  const { code, pushes, err } = await push(
    [OVER_WITH_CATALOG],
    ['--strict-budget'],
    { env: LOCAL_ENV },
  );
  assert.equal(code, 1);
  assert.equal(pushes.length, 0);
  assert.match(err, /--strict-budget/);
});

test('--no-strict-budget opts out under CI: the old warn-and-push', async () => {
  const { code, pushes, payload } = await push(
    [OVER_WITH_CATALOG],
    ['--no-strict-budget'],
    { env: CI_ENV },
  );
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  assert.equal('collected' in payload, false);
});

test('CI=false is not CI: the default stays warn-and-push', async () => {
  const { code, pushes } = await push([OVER_WITH_CATALOG], [], {
    env: { ...PUSH_ENV, CI: 'false' },
  });
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
});

test('under CI, a payload within budget pushes with its catalog as before', async () => {
  const { code, pushes, payload } = await push([bigReport(50)], [], {
    env: CI_ENV,
  });
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  assert.equal(payload.collected.length, 50);
});

test('under CI, --no-collected within budget is not a lost catalog', async () => {
  const { code, pushes } = await push([OVER_WITH_CATALOG], ['--no-collected'], {
    env: CI_ENV,
  });
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
});
