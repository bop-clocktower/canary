/**
 * #1354: failure text is redacted before it reaches the TestTracker dashboard.
 *
 * Live-environment suites sign in as real test members, and their failures
 * echo what a step typed or saw. Every planted value below is assembled at
 * runtime from obviously fake parts, so this file holds no credential-shaped
 * literal for a secret scanner (or a reader) to trip on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reporterModule,
  fakeTest,
  fakeResult,
  runReporter,
  CI_ENV,
  T,
} = require('./ingest-harness.js');
const { PUSH_ENV, tempReport, push } = require('./testtracker-harness.js');
const { buildPayload, resolveConfig, redactText, redactTitle } = reporterModule;

// --- planted positives (fake, built at runtime) -------------------------------
const EMAIL = ['qa.member+fixture', 'example.test'].join('@');
const b64url = (s) => Buffer.from(s).toString('base64url');
const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"sub":"fixture-member","iat":1}'),
  b64url('not-a-real-signature-just-fixture-bytes'),
].join('.');
// 36 token characters with both a digit and a letter.
const BARE = 'Fx7'.repeat(12);
const NAMED_VALUE = ['fixture', 'pass', 'phrase', '42'].join('-');
const NAMED_ENV = {
  CANARY_INGEST_REDACT_ENV: 'MEMBER_PASSWORD',
  MEMBER_PASSWORD: NAMED_VALUE,
};

const leaks = (text) =>
  [EMAIL, JWT, BARE, NAMED_VALUE].filter((v) => text.includes(v));

// --- the rules ----------------------------------------------------------------

test('redactText replaces emails, JWTs, bare credentials and named env values', () => {
  const text =
    `login as ${EMAIL} failed; header Bearer ${JWT}; ` +
    `api key ${BARE}; typed ${NAMED_VALUE}`;
  const out = redactText(text, NAMED_ENV);
  assert.deepEqual(leaks(out), []);
  assert.match(out, /login as <email> failed/);
  assert.match(out, /Bearer <token>;/);
  assert.match(out, /api key <token>;/);
  assert.match(out, /typed <secret:MEMBER_PASSWORD>/);
});

test('the bare-credential rule needs a digit AND a letter, so long identifiers survive', () => {
  const ident = 'ActivityCompletionDefinitionSchemaValidator';
  const digits = '1234567890'.repeat(4);
  assert.equal(redactText(`expected ${ident}`, {}), `expected ${ident}`);
  assert.equal(redactText(`count ${digits}`, {}), `count ${digits}`);
  // 31 characters is under the threshold.
  const short = 'Fx7'.repeat(10) + 'F';
  assert.equal(redactText(short, {}), short);
});

test('stack paths are not swallowed by the bare-credential rule', () => {
  const frame =
    '    at Object.<anonymous> (/home/runner/work/canary/canary/tests/e2e/checkout-flow-2fa.spec.ts:42:7)';
  assert.equal(redactText(frame, {}), frame);
});

test('redactTitle applies only the email, JWT and named-secret rules', () => {
  const title = `signs in as ${EMAIL} with ${NAMED_VALUE} > keeps ${BARE}`;
  const out = redactTitle(title, NAMED_ENV);
  assert.equal(
    out,
    `signs in as <email> with <secret:MEMBER_PASSWORD> > keeps ${BARE}`,
    'titles keep their shape: the bare-credential rule never touches full_title',
  );
});

test('CANARY_INGEST_REDACT=0 turns redaction off', () => {
  const text = `login as ${EMAIL}`;
  assert.equal(redactText(text, { CANARY_INGEST_REDACT: '0' }), text);
  assert.equal(redactTitle(text, { CANARY_INGEST_REDACT: 'false' }), text);
});

test('named env values shorter than 6 characters are not redacted (they would shred the text)', () => {
  const env = {
    CANARY_INGEST_REDACT_ENV: 'PIN, MEMBER_PASSWORD ,UNSET',
    PIN: 'a1',
    MEMBER_PASSWORD: NAMED_VALUE,
  };
  const out = redactText(`pin a1 then ${NAMED_VALUE}`, env);
  assert.equal(out, 'pin a1 then <secret:MEMBER_PASSWORD>');
});

test('redaction is idempotent: its own placeholders are never re-redacted', () => {
  const once = redactText(`${EMAIL} ${JWT} ${BARE}`, NAMED_ENV);
  assert.equal(redactText(once, NAMED_ENV), once);
});

test('redaction stays linear on long runs with no match (8 KB stacks go through it)', () => {
  // A quadratic rule took ~50 ms per 8 KB field; a run of many failures
  // multiplies that. 20 passes over each shape must stay well under a second.
  const shapes = ['a'.repeat(8000), 'a.'.repeat(4000), '-'.repeat(8000)];
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) for (const s of shapes) redactText(s, {});
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

// --- the payload builder (the one choke point both push paths share) ----------

const cfg = resolveConfig(
  { suite: 'web', url: 'https://dash.example', token: 'tok' },
  {},
);

test('buildPayload redacts message, stack, reason tags and titles before they hit the wire', () => {
  const rows = [
    {
      full_title: `a.spec.ts > signs in as ${EMAIL}`,
      test_file: 'a.spec.ts',
      status: 'failed',
      error_message: `expected ${NAMED_VALUE} to be accepted`,
      error_stack: `Error: 401 for Bearer ${JWT}\n    at login (a.spec.ts:3:1)`,
      retries: 0,
      tags: ['smoke', `reason:waiting on key ${BARE}`],
    },
  ];
  const collected = [
    {
      full_title: `a.spec.ts > signs in as ${EMAIL}`,
      test_file: 'a.spec.ts',
      tags: [],
    },
  ];
  const p = buildPayload(rows, cfg, T, { ...CI_ENV, ...NAMED_ENV }, 'failed', {
    collected,
  });
  assert.deepEqual(leaks(JSON.stringify(p)), []);
  assert.equal(p.results[0].full_title, 'a.spec.ts > signs in as <email>');
  assert.equal(
    p.results[0].error_message,
    'expected <secret:MEMBER_PASSWORD> to be accepted',
  );
  assert.match(p.results[0].error_stack, /Bearer <token>/);
  assert.deepEqual(p.results[0].tags, [
    'smoke',
    'reason:waiting on key <token>',
  ]);
  assert.equal(p.collected[0].full_title, 'a.spec.ts > signs in as <email>');
});

test('two titles that redact to the same text become one row, not a rejected run', () => {
  const other = ['someone.else', 'example.test'].join('@');
  const row = (email, status) => ({
    full_title: `a.spec.ts > signs in as ${email}`,
    test_file: 'a.spec.ts',
    status,
    retries: 0,
    tags: [],
  });
  const collected = [EMAIL, other].map((e) => ({
    full_title: `a.spec.ts > signs in as ${e}`,
    test_file: 'a.spec.ts',
    tags: [],
  }));
  const p = buildPayload(
    [row(EMAIL, 'passed'), row(other, 'failed')],
    cfg,
    T,
    CI_ENV,
    undefined,
    { collected },
  );
  assert.equal(
    p.results.length,
    1,
    'the ingest API rejects the whole run on a duplicate full_title',
  );
  assert.equal(p.results[0].status, 'failed', 'worst status wins');
  assert.equal(p.totals.total, 1);
  assert.equal(p.collected.length, 1);
});

test('buildPayload sends text untouched when CANARY_INGEST_REDACT=0', () => {
  const rows = [
    {
      full_title: `t ${EMAIL}`,
      test_file: 'a',
      status: 'failed',
      error_message: EMAIL,
      retries: 0,
      tags: [],
    },
  ];
  const p = buildPayload(rows, cfg, T, {
    ...CI_ENV,
    CANARY_INGEST_REDACT: '0',
  });
  assert.equal(p.results[0].error_message, EMAIL);
  assert.equal(p.results[0].full_title, `t ${EMAIL}`);
});

// --- end to end: both push paths ----------------------------------------------

test('Playwright reporter: a failure that echoes credentials reaches the dashboard redacted', async () => {
  const t = fakeTest({
    title: `member ${EMAIL} checks out`,
    annotations: [{ type: 'skip', description: `blocked by ${BARE}` }],
  });
  const { payload } = await runReporter({
    tests: [
      [
        t,
        fakeResult('failed', {
          errors: [{ message: `typed ${NAMED_VALUE}`, stack: `Bearer ${JWT}` }],
        }),
      ],
    ],
    env: NAMED_ENV,
  });
  assert.ok(payload, 'the run was pushed');
  assert.deepEqual(leaks(JSON.stringify(payload)), []);
});

test('Playwright reporter: a secret straddling the truncation boundary leaves no fragment', async () => {
  // errorField truncates at 4,000 characters. Redaction runs first, so the
  // cut can never land inside a value and leave a half-secret on the wire.
  const pad = 'x '.repeat(1990); // 3,980 characters: the cut lands ~19 characters into the token
  const t = fakeTest({ title: 'long failure' });
  const { payload } = await runReporter({
    tests: [
      [t, fakeResult('failed', { errors: [{ message: `${pad} ${JWT}` }] })],
    ],
  });
  const msg = payload.results[0].error_message;
  assert.ok(
    !msg.includes(JWT.slice(0, 10)),
    'no leading fragment of the token survives the cut',
  );
});

test('testtracker push (JUnit): message, body, skip reason and title are redacted', async () => {
  const file = tempReport(
    '<?xml version="1.0"?><testsuites><testsuite name="s">' +
      `<testcase classname="a.test.js" name="login ${EMAIL}"><failure message="typed ${NAMED_VALUE}">Bearer ${JWT}</failure></testcase>` +
      `<testcase classname="a.test.js" name="later"><skipped message="needs ${BARE}"/></testcase>` +
      '</testsuite></testsuites>',
  );
  const { code, payload } = await push([file], [], {
    env: { ...PUSH_ENV, ...NAMED_ENV },
  });
  assert.equal(code, 0);
  assert.deepEqual(leaks(JSON.stringify(payload)), []);
  assert.ok(
    payload.results.some((r) => r.full_title.includes('login <email>')),
  );
});
