/**
 * canary-cry's browser runtime, the parts that need no browser (#608 P3).
 * The runtime itself is proven against real Chromium by the cry-e2e suite
 * (test/e2e/); these pin its pure rules and its probe failure modes:
 *
 * - SC21 a probe that errors -- HTTP 500, shell exit 1, an absent jsonPath --
 *        is an error the verdict turns into probe-failed, never a value
 * - the egress allowlist is the gate's host rule
 * - a cross-account leak is reported by field NAME
 * - every catalog pattern has a runner; anything else is refused loudly
 */
import { describe, expect, it } from 'vitest';

import {
  INTENSITY_CEILING,
  PATTERNS as CATALOG,
} from '../claude-code/canary-cry/scripts/patterns.mjs';
import {
  INTENSITY_CEILING as RUNTIME_CEILING,
  PATTERNS,
  inject,
} from '../claude-code/canary-cry/scripts/runtime/abuse.mjs';
import {
  INJECTED_HEADER,
  hostAllowed,
  leakedFields,
  observe,
} from '../claude-code/canary-cry/scripts/runtime/guard.mjs';
import {
  jsonPath,
  readProbe,
} from '../claude-code/canary-cry/scripts/runtime/probes.mjs';
import {
  lookupFor,
  requestMatcher,
  resolve,
  uniqueValue,
} from '../claude-code/canary-cry/scripts/runtime/steps.mjs';
import { scenarioVerdict } from '../claude-code/canary-cry/scripts/verdict.mjs';

describe('jsonPath', () => {
  const doc = { a: { b: [10, 20] }, 'two words': 1, s: 'xyz' };
  it.each<[string, any]>([
    ['$', { found: true, value: doc }],
    ['$.a.b[1]', { found: true, value: 20 }],
    ['$.a.b.length', { found: true, value: 2 }],
    ['$.s.length', { found: true, value: 3 }],
    ['$["two words"]', { found: true, value: 1 }],
    ['$.a.c', { found: false }],
    ['$.a.b[5]', { found: false }],
    ['$.s.x', { found: false }],
    ['$..a', { found: false }],
  ])('%s', (p, want) => {
    expect(jsonPath(doc, p)).toEqual(want);
  });
});

/** A fake APIRequestContext answering every probe with one response. */
const answer = (status: number, body: string) => ({
  fetch: async () => ({
    ok: () => status < 300,
    status: () => status,
    text: async () => body,
  }),
});
const http = (jp?: string) => ({
  probe: { http: { method: 'GET', path: '/n' } },
  expect: jp === undefined ? { delta: 1 } : { jsonPath: jp, delta: 1 },
});
const id = (t: string) => t;

describe('readProbe (SC21)', () => {
  it('reads a JSON body through jsonPath', async () => {
    expect(await readProbe(http('$.length'), answer(200, '[1,2]'), id)).toEqual(
      {
        value: 2,
      },
    );
  });

  it('keeps a non-JSON body as trimmed text', async () => {
    expect(await readProbe(http(), answer(200, ' 3 rows \n'), id)).toEqual({
      value: '3 rows',
    });
  });

  it('an HTTP 500 is an error', async () => {
    expect(await readProbe(http('$.n'), answer(500, '{}'), id)).toEqual({
      error: 'HTTP 500',
    });
  });

  it('an absent jsonPath is an error', async () => {
    expect(await readProbe(http('$.n'), answer(200, '{}'), id)).toEqual({
      error: 'jsonPath $.n is absent',
    });
  });

  it('a request that throws (a timeout) is an error', async () => {
    const request = {
      fetch: async () => {
        throw new Error('Request timed out after 30000ms');
      },
    };
    expect(await readProbe(http(), request, id)).toEqual({
      error: 'Request timed out after 30000ms',
    });
  });

  const shell = (code: string) => ({
    probe: { shell: { argv: [process.execPath, '-e', code] } },
    expect: { equals: 1 },
  });

  it('a shell probe reads stdout, templates resolved per argv element', async () => {
    const inv = shell('console.log(JSON.stringify({n: "{{x}}"}))');
    const r = await readProbe(inv, {}, (t: string) => t.replace('{{x}}', 'ok'));
    expect(r).toEqual({ value: { n: 'ok' } });
  });

  it('a shell probe exiting 1 is an error, and the verdict abstains', async () => {
    const r = await readProbe(shell('process.exit(1)'), {}, id);
    expect(r).toEqual({ error: 'shell exit 1' });
    const v = scenarioVerdict({
      flow: 'f',
      pattern: 'multi-submit',
      brokenAt: null,
      invariants: [{ id: 'one', error: r.error }],
      signals: [],
    });
    expect(v.reason).toBe('probe-failed@one');
  });
});

describe('templates', () => {
  const source = {
    accounts: { A: { email: 'a@x.test', id: 7 }, B: { email: 'b@x.test' } },
    fixtures: { card: 4242 },
    seed: 3,
    id: 'f:p:i1:ss',
  };

  it('resolves account, fixture and unique values', () => {
    const look = lookupFor(source);
    expect(resolve('{{account.A.email}}/{{account.A.id}}', look)).toBe(
      'a@x.test/7',
    );
    expect(resolve('{{fixture.card}}', look)).toBe('4242');
    expect(resolve('{{unique.email}}', look)).toBe(
      uniqueValue(3, 'f:p:i1:ss', 'email'),
    );
  });

  it('aliases A to B for the second user of a shared machine', () => {
    expect(resolve('{{account.A.email}}', lookupFor(source, { A: 'B' }))).toBe(
      'b@x.test',
    );
  });

  it('refuses a reference it cannot resolve instead of typing a blank', () => {
    expect(() => resolve('{{account.B.id}}', lookupFor(source))).toThrow(
      'unresolved template {{account.B.id}}',
    );
  });

  it('unique values are seed- and scenario-bound, and emails use .invalid', () => {
    expect(uniqueValue(1, 's', 'email')).toMatch(
      /^cry\.[0-9a-f]{8}@cry\.invalid$/,
    );
    expect(uniqueValue(1, 's', 'name')).toMatch(/^cry-name-[0-9a-f]{8}$/);
    expect(uniqueValue(1, 's', 'name')).toBe(uniqueValue(1, 's', 'name'));
    expect(uniqueValue(2, 's', 'name')).not.toBe(uniqueValue(1, 's', 'name'));
    expect(uniqueValue(1, 't', 'name')).not.toBe(uniqueValue(1, 's', 'name'));
  });
});

describe('requestMatcher', () => {
  const req = (method: string, url: string) => ({
    method: () => method,
    url: () => url,
  });
  it('matches method and path, ignoring the query unless the spec has one', () => {
    const m = requestMatcher('POST /api/orders');
    expect(m(req('POST', 'http://h/api/orders?x=1'))).toBe(true);
    expect(m(req('GET', 'http://h/api/orders'))).toBe(false);
    expect(m(req('POST', 'http://h/api/orders/2'))).toBe(false);
    expect(requestMatcher('GET /a?b=1')(req('GET', 'http://h/a?b=1'))).toBe(
      true,
    );
  });
});

describe('the egress allowlist', () => {
  it.each<[string, string[], boolean]>([
    ['staging.example.test', ['staging.example.test'], true],
    ['STAGING.example.test.', ['staging.example.test:443'], true],
    ['api.example.test', ['*.example.test'], true],
    ['example.test', ['*.example.test'], true],
    ['evil.test', ['staging.example.test'], false],
    ['notexample.test', ['*.example.test'], false],
  ])('%s against %j -> %s', (host, hosts, want) => {
    expect(hostAllowed(host, hosts)).toBe(want);
  });
});

/** A fake response event: status, headers, method and path. */
const response = (status: number, headers: Record<string, string> = {}) => ({
  url: () => 'http://127.0.0.1:9/api/orders',
  status: () => status,
  headers: () => headers,
  request: () => ({ method: () => 'POST' }),
});

describe('the http-5xx signal', () => {
  /** observe() on a fake context; returns what one response signals. */
  function signalsFor(res: object) {
    const on: Record<string, (x: any) => void> = {};
    const seen: string[] = [];
    const context = { on: (name: string, fn: any) => (on[name] = fn) };
    observe(context, {
      hosts: ['127.0.0.1'],
      signal: (kind: string, detail: string) => seen.push(`${kind} ${detail}`),
      inflight: { n: 0 },
    });
    on.response!(res);
    return seen;
  }

  it("records the app's own 5xx", () => {
    expect(signalsFor(response(502))).toEqual([
      'http-5xx POST /api/orders 502',
    ]);
  });

  // #608 P4: stale-optimistic i2 answers the client with a fake 500 of its
  // own. That is the abuse, not a symptom of the app.
  it("never records canary-cry's injected fake 500", () => {
    expect(
      signalsFor(response(500, { [INJECTED_HEADER]: 'fake-500' })),
    ).toEqual([]);
  });
});

describe('leakedFields (SC25)', () => {
  const A = { email: 'alice@x.test', password: 'pw-a-1', id: '7' };
  const B = { email: 'bob@x.test', password: 'pw-a-1', id: '8' };

  it("names a field of A visible on B's page, never the value", () => {
    expect(leakedFields(['Ship to alice@x.test'], A, B)).toEqual([
      'account.A.email',
    ]);
  });

  it('ignores a value B shares and one too short to mean anything', () => {
    expect(leakedFields(['pw-a-1 and 7'], A, B)).toEqual([]);
  });

  it('scans form field values too (autofill)', () => {
    expect(leakedFields(['', 'alice@x.test'], A, B)).toEqual([
      'account.A.email',
    ]);
  });
});

describe('the pattern runners', () => {
  it('implement every pattern in the catalog, and nothing else', () => {
    expect(Object.keys(PATTERNS).sort()).toEqual(
      CATALOG.map((p: any) => p.id).sort(),
    );
  });

  it.each([0, 4, 1.5])(
    'refuse intensity %s, past the ceiling or not a round, loudly',
    (intensity) => {
      const session = { scenario: { pattern: 'multi-submit', intensity } };
      expect(() => inject(session)).toThrow(
        `multi-submit at intensity ${intensity} is not implemented`,
      );
    },
  );

  it('stop at the catalog ceiling', () => {
    expect(RUNTIME_CEILING).toBe(INTENSITY_CEILING);
  });

  it('refuse an unknown pattern', () => {
    const session = { scenario: { pattern: 'telepathy', intensity: 1 } };
    expect(() => inject(session)).toThrow(
      'pattern telepathy is not implemented',
    );
  });
});
