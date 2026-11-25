/**
 * canary-cry's manifest and manifest-sha (#608 P2, ADR 0046 decision 1, spec
 * D4/D6). The manifest is the whole blast radius an operator approves; the sha
 * binds that approval to exactly what was shown.
 *
 * SC9: any change to what would run changes the sha -- proven field by field
 * below, not by one mutation standing in for all of them.
 * SC10: every probe verbatim, every write step, egress hosts, account env var
 * NAMES, the server-side limit line, and never an env var's value.
 */
import { describe, expect, it } from 'vitest';

import { gateTarget } from '../claude-code/canary-cry/scripts/gate.mjs';
import {
  SERVER_SIDE_LIMIT,
  buildManifest,
  canonicalJson,
  manifestSha,
} from '../claude-code/canary-cry/scripts/manifest.mjs';
import { buildMatrix } from '../claude-code/canary-cry/scripts/matrix.mjs';

// Factories, never shared constants: the SC9 cases mutate what they are given,
// and a mutated shared object would make every later case pass vacuously.
// Split so no factory nests past the arch nestingDepth threshold (4).
const shellProbe = () => ({
  shell: { argv: ['psql', '-tAc', 'select count(*) from orders'] },
});
const httpProbe = () => ({
  http: { method: 'GET', path: '/api/orders?user={{account.A.id}}' },
});

function checkoutSteps(): any[] {
  return [
    { id: 'open', action: 'goto', url: '/cart' },
    {
      id: 'card',
      action: 'fill',
      selector: '[name=card]',
      value: '{{fixture.card}}',
    },
    {
      id: 'pay',
      action: 'click',
      selector: '#pay',
      writes: true,
      awaitResponse: 'POST /api/orders',
    },
  ];
}

function checkoutInvariants(): any[] {
  return [
    {
      id: 'one-order',
      probe: httpProbe(),
      expect: { jsonPath: '$.length', delta: 1 },
    },
    { id: 'db-count', probe: shellProbe(), expect: { equals: 1 } },
  ];
}

function flowsDoc(): any {
  const checkout = {
    id: 'checkout',
    risk: 5,
    steps: checkoutSteps(),
    invariants: checkoutInvariants(),
  };
  const login = {
    id: 'login',
    risk: 1,
    steps: [{ id: 'open', action: 'goto', url: '/login' }],
  };
  return {
    version: 1,
    fixtures: { card: '4242424242424242' },
    flows: [checkout, login],
  };
}

function stagingTarget(): any {
  return {
    baseURL: 'https://staging.example.test',
    environment: 'staging',
    hosts: ['staging.example.test', 'cdn.example.test'],
    accounts: { A: { env: 'CRY_ACCOUNT_A' }, B: { env: 'CRY_ACCOUNT_B' } },
    auth: {
      signIn: 'login',
      signOut: 'login',
      sessionKeys: ['cookie:session'],
    },
  };
}

function targetsDoc(): any {
  return {
    version: 1,
    prodHosts: ['*.prod.example'],
    targets: { staging: stagingTarget() },
  };
}

function manifestOf(
  flows = flowsDoc(),
  tdoc = targetsDoc(),
  amplitude = 'whisper',
  seed = 0,
) {
  const target = gateTarget(tdoc, 'staging').target!;
  const matrix = buildMatrix({ flows: flows.flows, amplitude, seed, target });
  return buildManifest({ flowsDoc: flows, target, matrix });
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('manifest contents (SC10)', () => {
  const m = manifestOf();
  const text = canonicalJson(m);

  it('is versioned and names the target, its environment and baseURL', () => {
    expect(m.format).toBe('canary.cry-manifest/1');
    expect(m.target).toEqual({
      name: 'staging',
      baseURL: 'https://staging.example.test',
      environment: 'staging',
    });
  });

  it('lists the egress hosts exactly as declared', () => {
    expect(m.egressHosts).toEqual(['staging.example.test', 'cdn.example.test']);
  });

  it('lists account env var names, never values', () => {
    expect(m.accounts).toEqual([
      { account: 'A', env: 'CRY_ACCOUNT_A' },
      { account: 'B', env: 'CRY_ACCOUNT_B' },
    ]);
  });

  it('lists every probe verbatim, shell argv included', () => {
    expect(m.probes).toEqual([
      {
        flow: 'checkout',
        invariant: 'one-order',
        probe: httpProbe(),
        expect: { jsonPath: '$.length', delta: 1 },
      },
      {
        flow: 'checkout',
        invariant: 'db-count',
        probe: shellProbe(),
        expect: { equals: 1 },
      },
    ]);
  });

  it('lists every write step of the flows it will drive', () => {
    expect(m.writes).toEqual([
      {
        flow: 'checkout',
        step: 'pay',
        action: 'click',
        selector: '#pay',
        awaitResponse: 'POST /api/orders',
      },
    ]);
  });

  it('carries every scheduled scenario, amplitude and seed', () => {
    const matrix = buildMatrix({
      flows: flowsDoc().flows,
      amplitude: 'whisper',
      seed: 0,
      target: gateTarget(targetsDoc(), 'staging').target,
    });
    expect(m.scenarios).toEqual(matrix.scenarios);
    expect(m.scenarios.length).toBeGreaterThan(0);
    expect(m.amplitude).toBe('whisper');
    expect(m.seed).toBe(0);
  });

  it('includes the driven flows in full, plus the auth flows, and the fixtures', () => {
    expect(m.flows.map((f: any) => f.id)).toEqual(['checkout', 'login']);
    expect(m.flows[0]).toEqual(flowsDoc().flows[0]);
    expect(m.fixtures).toEqual({ card: '4242424242424242' });
  });

  it('states the server-side limit line verbatim', () => {
    expect(SERVER_SIDE_LIMIT).toBe(
      'server-side side effects (email, webhooks, payments) are NOT intercepted by canary-cry.',
    );
    expect(m.serverSideLimit).toBe(SERVER_SIDE_LIMIT);
  });

  // The planted-secret half of SC10 lives in canary-cry-run.test.ts, on the
  // path that actually reads the env vars; buildManifest never sees them.
  it('carries no credential field at all', () => {
    expect(text).not.toMatch(/password|"email"/i);
  });
});

describe('manifestSha (SC9)', () => {
  const base = manifestSha(manifestOf());

  it('is a sha256 hex digest and stable across rebuilds', () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestSha(manifestOf())).toBe(base);
  });

  it('ignores key order (canonical JSON)', () => {
    const m = manifestOf();
    const reordered = Object.fromEntries(Object.entries(m).reverse());
    expect(manifestSha(reordered)).toBe(base);
  });

  type Mutation = [string, (f: any, t: any) => void];
  const mutations: Mutation[] = [
    [
      'a step selector',
      (f) => {
        f.flows[0].steps[2].selector = '#pay-now';
      },
    ],
    [
      'a step url',
      (f) => {
        f.flows[0].steps[0].url = '/basket';
      },
    ],
    [
      'a fill value',
      (f) => {
        f.flows[0].steps[1].value = '4000000000000002';
      },
    ],
    [
      'a flow risk',
      (f) => {
        f.flows[0].risk = 4;
      },
    ],
    [
      'an http probe path',
      (f) => {
        f.flows[0].invariants[0].probe.http.path = '/api/orders';
      },
    ],
    [
      'a shell probe argv',
      (f) => {
        f.flows[0].invariants[1].probe.shell.argv.push('--host=prod');
      },
    ],
    [
      'an invariant expectation',
      (f) => {
        f.flows[0].invariants[0].expect.delta = 2;
      },
    ],
    [
      'a fixture value',
      (f) => {
        f.fixtures.card = '5555555555554444';
      },
    ],
    [
      'an auth flow step',
      (f) => {
        f.flows[1].steps[0].url = '/signin';
      },
    ],
    [
      'the baseURL',
      (_f, t) => {
        t.targets.staging.baseURL = 'https://staging2.example.test';
      },
    ],
    [
      'an egress host',
      (_f, t) => {
        t.targets.staging.hosts.push('evil.example.test');
      },
    ],
    [
      'an account env name',
      (_f, t) => {
        t.targets.staging.accounts.A.env = 'OTHER_A';
      },
    ],
    [
      'the environment',
      (_f, t) => {
        t.targets.staging.environment = 'dev';
      },
    ],
    [
      'a session key',
      (_f, t) => {
        t.targets.staging.auth.sessionKeys = ['cookie:sid'];
      },
    ],
  ];

  it.each(mutations)('changes when %s changes', (_label, mutate) => {
    const f = flowsDoc();
    const t = targetsDoc();
    mutate(f, t);
    expect(manifestSha(manifestOf(f, t))).not.toBe(base);
  });

  it('changes with the seed', () => {
    expect(
      manifestSha(manifestOf(flowsDoc(), targetsDoc(), 'whisper', 1)),
    ).not.toBe(base);
  });

  it('changes with the amplitude', () => {
    expect(manifestSha(manifestOf(flowsDoc(), targetsDoc(), 'shout'))).not.toBe(
      base,
    );
  });
});
