/**
 * #1400 part 2: named-secret redaction is idempotent.
 *
 * buildPayload redacts every failure field twice (errorField, then
 * redactEntry), so a second pass must leave the first pass's placeholders
 * alone. Planted values are assembled at runtime from obviously fake parts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { reporterModule, CI_ENV, T } = require('./ingest-harness.js');
const { buildPayload, resolveConfig, redactText, redactTitle } = reporterModule;

const NAMED_VALUE = ['fixture', 'pass', 'phrase', '42'].join('-');
const leaks = (text) => [NAMED_VALUE].filter((v) => text.includes(v));
const cfg = resolveConfig(
  { suite: 'web', url: 'https://dash.example', token: 'tok' },
  {},
);

// #1400 part 2: buildPayload redacts a field twice (errorField, then
// redactEntry), so a named value that is a substring of its own placeholder
// must not be replaced again inside it.
test('a named value inside its own placeholder survives a second pass', () => {
  const env = { CANARY_INGEST_REDACT_ENV: 'TOK', TOK: 'secret' };
  const once = redactText('typed secret into the form', env);
  assert.equal(once, 'typed <secret:TOK> into the form');
  assert.equal(redactText(once, env), once);
  assert.equal(redactTitle(redactTitle(once, env), env), once);
});

test("one named value never lands inside another name's placeholder", () => {
  // B's value is A's name, so a sequential replace would rewrite A's
  // placeholder in the same pass: <secret:<secret:B>>.
  const env = {
    CANARY_INGEST_REDACT_ENV: 'MEMBER_PASSWORD,ALIAS',
    MEMBER_PASSWORD: NAMED_VALUE,
    ALIAS: 'MEMBER_PASSWORD',
  };
  const once = redactText(`pw ${NAMED_VALUE} env MEMBER_PASSWORD`, env);
  assert.equal(once, 'pw <secret:MEMBER_PASSWORD> env <secret:ALIAS>');
  assert.equal(redactText(once, env), once);
});

test('only configured placeholders are kept: look-alike text cannot hide a value', () => {
  const env = {
    CANARY_INGEST_REDACT_ENV: 'MEMBER_PASSWORD',
    MEMBER_PASSWORD: NAMED_VALUE,
  };
  const out = redactText(`<secret:note ${NAMED_VALUE}>`, env);
  assert.equal(out, '<secret:note <secret:MEMBER_PASSWORD>>');
  assert.deepEqual(leaks(out), []);
});

test('buildPayload keeps a row that errorField already redacted intact', () => {
  // errorField redacts message and stack first; buildPayload's redactEntry is
  // the second pass over the same text.
  const env = { ...CI_ENV, CANARY_INGEST_REDACT_ENV: 'TOK', TOK: 'secret' };
  const message = redactText('login failed with secret', env);
  const rows = [
    {
      full_title: 'a.spec.ts > signs in',
      test_file: 'a.spec.ts',
      status: 'failed',
      error_message: message,
      error_stack: redactText('Error: secret\n    at a.spec.ts:3:1', env),
      retries: 0,
      tags: [],
    },
  ];
  const p = buildPayload(rows, cfg, T, env, 'failed');
  assert.equal(p.results[0].error_message, 'login failed with <secret:TOK>');
  assert.equal(
    p.results[0].error_stack,
    'Error: <secret:TOK>\n    at a.spec.ts:3:1',
  );
});
