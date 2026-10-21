/**
 * #1400 (CWE-1333): the ingest reporter's JWT redaction rule stays linear-time
 * and redacts exactly what the pre-#1400 regex did. Split from
 * ingest-redact.test.js to keep each file under the 300-line threshold.
 * Every planted value is assembled at runtime from obviously fake parts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { reporterModule } = require('./ingest-harness.js');
const { redactText, redactTitle } = reporterModule;

const b64url = (s) => Buffer.from(s).toString('base64url');
const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"sub":"fixture-member","iat":1}'),
  b64url('not-a-real-signature-just-fixture-bytes'),
].join('.');

// --- #1400: the JWT rule stays linear and redacts what it always did ----------

// The pre-#1400 rule, kept verbatim as the reference the rewrite must agree with.
const OLD_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

test('#1400 the JWT rule stays linear on a long run of eyJ- with no dot (CWE-1333)', () => {
  // The old rule retried from every `eyJ` in the run: 64 KB ~0.5 s, 256 KB ~8-13 s.
  const hostile = 'eyJ-'.repeat(65536); // 256 KB
  const start = process.hrtime.bigint();
  redactTitle(hostile, {});
  redactText(hostile, {});
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

test('#1400 the JWT rule stays linear when the run ends in a single dotted segment', () => {
  const hostile = 'eyJ-'.repeat(65536) + '.a';
  const start = process.hrtime.bigint();
  redactTitle(hostile, {});
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

test('#1400 a JWT is still redacted after a space, quote, Bearer, =, :, -, ( and at the start', () => {
  for (const before of [
    '',
    ' ',
    '"',
    "'",
    'Bearer ',
    'token=',
    'jwt:',
    'x-',
    '(',
  ]) {
    const out = redactTitle(`${before}${JWT} tail`, {});
    assert.equal(
      out,
      `${before}<token> tail`,
      `prefix ${JSON.stringify(before)}`,
    );
  }
});

test('#1400 an eyJ glued to a word character is not a JWT start (unchanged \\b semantics)', () => {
  const glued = `x${JWT}`;
  assert.equal(redactTitle(glued, {}), glued);
});

test('#1400 several JWTs in one dotted run are each redacted, like the old rule', () => {
  const text = `a.${JWT}.${JWT}.b`;
  assert.equal(redactTitle(text, {}), text.replace(OLD_JWT, '<token>'));
});

test('#1400 the JWT rule agrees with the pre-#1400 regex on random token text', () => {
  // Small alphabet so eyJ starts, dashes, dots and boundaries collide often.
  const parts = [
    'eyJ',
    'e',
    'y',
    'J',
    'a',
    '-',
    '_',
    '.',
    '.',
    ' ',
    '9',
    'x-eyJ',
    '..',
  ];
  let seed = 1400;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 5000; i++) {
    let s = '';
    const len = 1 + rand(14);
    for (let j = 0; j < len; j++) s += parts[rand(parts.length)];
    assert.equal(
      redactTitle(s, {}),
      s.replace(OLD_JWT, '<token>'),
      `input ${JSON.stringify(s)}`,
    );
  }
});
