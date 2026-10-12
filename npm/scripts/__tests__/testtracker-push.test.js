/**
 * `canary testtracker push --junit <file…>` (#1320): JUnit XML from vitest,
 * `node --test`, Newman and Maestro reaches the same ingest payload the
 * Playwright reporter sends, through the reporter's own payload builder and
 * push. The HTTP push is stubbed; every assertion is on what reaches the wire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { route } = require('../../dist/router.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'junit');
const fixture = (name) => path.join(FIXTURES, name);
const PUSH_ENV = {
  CANARY_INGEST_URL: 'https://dash.example',
  CANARY_INGEST_TOKEN: 'tok',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
};

/** A JUnit report written to a temp file, for one-off shapes. */
function tempReport(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-junit-'));
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, xml);
  return file;
}

/** Runs `canary testtracker <args>` through the router with fetch stubbed. */
async function runCli(args, { env = PUSH_ENV, responses = [] } = {}) {
  const requests = [];
  const logs = [];
  let out = '';
  let err = '';
  const realFetch = global.fetch;
  const realLog = console.log;
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    const r = responses.shift() ?? {
      status: 200,
      json: {
        id: 7,
        duplicate: false,
        result_count: body?.results?.length ?? 0,
        collected_count: body?.collected?.length ?? null,
      },
    };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? ''),
    };
  };
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await route(['testtracker', ...args], {
      out: { write: (s) => (out += s) },
      err: { write: (s) => (err += s) },
      env,
      retryDelaysMs: [0, 0],
    });
  } finally {
    global.fetch = realFetch;
    console.log = realLog;
  }
  const pushes = requests.filter((r) => r.method === 'POST');
  return {
    code,
    out,
    err,
    logs,
    requests,
    pushes,
    payload: pushes.at(-1)?.body,
  };
}

const push = (files, extra = [], opts) =>
  runCli(
    [
      'push',
      ...files.flatMap((f) => ['--junit', f]),
      '--suite',
      'unit',
      ...extra,
    ],
    opts,
  );
const row = (payload, title) => {
  const found = payload.results.find((r) => r.full_title === title);
  assert.ok(
    found,
    `no row titled "${title}" in ${payload.results.map((r) => r.full_title).join(' | ')}`,
  );
  return found;
};

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
