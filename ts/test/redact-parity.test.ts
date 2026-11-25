/**
 * #1566: the history redactor's credential rules are a port of the TestTracker
 * reporter's (`npm/src/reporters/ingest/redact.ts`, #1354). This runs the
 * npm reporter's own rule cases (npm/scripts/__tests__/ingest-redact.test.js)
 * through BOTH implementations and requires identical output, so a rule
 * changed on one side alone fails here instead of drifting silently.
 *
 * The npm module is loaded by a computed path: it lives outside this
 * package's tsconfig `rootDir`, and vitest transforms it at run time.
 */
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { redactCredentials, redactFailureText } from '../src/util/redact.js';

type Env = Record<string, string | undefined>;
type RedactText = (text: string, env?: Env) => string;

const EMAIL = ['qa.member+fixture', 'example.test'].join('@');
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const JWT = [
  b64url('{"alg":"none"}'),
  b64url('{"sub":"fixture-member","iat":1}'),
  b64url('not-a-real-signature-just-fixture-bytes'),
].join('.');
const BARE = 'Fx7'.repeat(12);
const NAMED_VALUE = ['fixture', 'pass', 'phrase', '42'].join('-');
const NAMED_ENV: Env = {
  CANARY_INGEST_REDACT_ENV: 'MEMBER_PASSWORD',
  MEMBER_PASSWORD: NAMED_VALUE,
};

/** [label, text, env] -- the npm suite's rule-level inputs, plus edge shapes. */
const CASES: Array<[string, string, Env]> = [
  [
    'all four rules',
    `login as ${EMAIL} failed; header Bearer ${JWT}; api key ${BARE}; typed ${NAMED_VALUE}`,
    NAMED_ENV,
  ],
  [
    'long identifier survives',
    'expected ActivityCompletionDefinitionSchemaValidator',
    {},
  ],
  ['long number survives', `count ${'1234567890'.repeat(4)}`, {}],
  ['31 chars is under the threshold', 'Fx7'.repeat(10) + 'F', {}],
  [
    'stack frame path is not swallowed',
    '    at Object.<anonymous> (/home/runner/work/canary/canary/tests/e2e/checkout-flow-2fa.spec.ts:42:7)',
    {},
  ],
  ['opt-out 0', `login as ${EMAIL}`, { CANARY_INGEST_REDACT: '0' }],
  ['opt-out false', `login as ${EMAIL}`, { CANARY_INGEST_REDACT: 'false' }],
  [
    'short named values are skipped',
    `pin a1 then ${NAMED_VALUE}`,
    {
      CANARY_INGEST_REDACT_ENV: 'PIN, MEMBER_PASSWORD ,UNSET',
      PIN: 'a1',
      MEMBER_PASSWORD: NAMED_VALUE,
    },
  ],
  [
    'placeholder is not re-redacted',
    `TOK=<secret:MEMBER_PASSWORD> then ${NAMED_VALUE}`,
    NAMED_ENV,
  ],
  [
    'a value running past a placeholder still wins',
    `<secret:MEMBER_PASSWORD${NAMED_VALUE}`,
    {
      CANARY_INGEST_REDACT_ENV: 'MEMBER_PASSWORD',
      MEMBER_PASSWORD: `>${NAMED_VALUE}`,
    },
  ],
  ['jwt after a dash', `id-${JWT}.tail`, {}],
  ['email-like without tld', 'user@localhost here', {}],
  [
    'overlapping values of two names merge, one name per value',
    `typed ${NAMED_VALUE}-extra and ${NAMED_VALUE}`,
    {
      CANARY_INGEST_REDACT_ENV: 'A,B,C',
      A: NAMED_VALUE,
      B: `${NAMED_VALUE}-extra`,
      C: NAMED_VALUE,
    },
  ],
  [
    'overlapping occurrences of one value merge',
    'abcabcabcabc',
    { CANARY_INGEST_REDACT_ENV: 'R', R: 'abcabc' },
  ],
];

let npmRedactText: RedactText;

beforeAll(async () => {
  const path = join(
    process.cwd(),
    '..',
    'npm',
    'src',
    'reporters',
    'ingest',
    'redact.ts',
  );
  const mod = (await import(path)) as { redactText: RedactText };
  npmRedactText = mod.redactText;
});

describe('history redactor parity with the TestTracker redactor (#1354)', () => {
  it.each(CASES)('%s', (_label, text, env) => {
    expect(redactCredentials(text, env)).toBe(npmRedactText(text, env));
  });

  it('both are idempotent on their own output', () => {
    const once = redactCredentials(`${EMAIL} ${JWT} ${BARE}`, NAMED_ENV);
    expect(redactCredentials(once, NAMED_ENV)).toBe(once);
    expect(npmRedactText(once, NAMED_ENV)).toBe(once);
  });

  it('redactFailureText is idempotent and adds only the ANSI and path rules', () => {
    const esc = String.fromCharCode(27);
    const text = `${esc}[31m${EMAIL}${esc}[39m at f (/opt/fixture-ci/x/lib.js:1:2)`;
    const once = redactFailureText(text, {}, '/repo');
    expect(once).toBe('<email> at f (<path>/lib.js:1:2)');
    expect(redactFailureText(once, {}, '/repo')).toBe(once);
  });

  it('a URL path after its host, and relative paths, are left alone', () => {
    const text = 'GET https://dash.example/api/v1/x failed in tests/a.spec.ts';
    expect(redactFailureText(text, {}, '/repo')).toBe(text);
  });

  it('a file:// URL to a Windows path is rewritten whole', () => {
    expect(
      redactFailureText(
        'at file:///C:/Users/fixture/a/b.js:1:1',
        {},
        'C:\\repo',
      ),
    ).toBe('at <path>/b.js:1:1');
    expect(
      redactFailureText('see file:///C:/repo/src/c.ts', {}, 'C:\\repo'),
    ).toBe('see src/c.ts');
  });

  it('Windows and file:// paths are rewritten too', () => {
    const text =
      'at f (C:\\Users\\fixture\\a\\b.js:1:1) and file:///repo/src/c.ts';
    expect(redactFailureText(text, {}, '/repo')).toBe(
      'at f (<path>/b.js:1:1) and src/c.ts',
    );
  });

  it('stays linear on long runs with no match', () => {
    const shapes = ['a'.repeat(8000), 'a.'.repeat(4000), '/a'.repeat(4000)];
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20; i++)
      for (const s of shapes) redactFailureText(s, {}, '/repo');
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(500);
  });
});
