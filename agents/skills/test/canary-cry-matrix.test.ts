/**
 * canary-cry scenario matrix (#608 P1: SC1-SC4, SC24 at the module).
 *
 * The 10-flow fixture spreads risk 1..5 twice, so every rank is decided by
 * score and the documented id tie-break: f04 and f09 are risk 5, f03 and f08
 * risk 4, and so on. Each flow has two write steps (`save`, which also awaits
 * a response, and `done`, the last step), which is enough for every pattern's
 * anchor to fire at least once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AMPLITUDES,
  buildMatrix,
  matrixJson,
} from '../claude-code/canary-cry/scripts/matrix.mjs';
import { PATTERNS } from '../claude-code/canary-cry/scripts/patterns.mjs';

afterEach(() => vi.restoreAllMocks());

function flows10(): any[] {
  return Array.from({ length: 10 }, (_, k) => ({
    id: `f${String(k).padStart(2, '0')}`,
    risk: (k % 5) + 1,
    steps: [
      { id: 'open', action: 'goto', url: '/' },
      {
        id: 'save',
        action: 'click',
        selector: '#save',
        writes: true,
        awaitResponse: 'POST /api/save',
      },
      { id: 'done', action: 'click', selector: '#done', writes: true },
    ],
  }));
}

/** A target that every target-scoped pattern applies to. */
const FULL_TARGET = {
  name: 'staging',
  spec: {
    accounts: { A: { env: 'CRY_A' }, B: { env: 'CRY_B' } },
    auth: { signIn: 'f00', signOut: 'f01', sessionKeys: ['cookie:session'] },
  },
};

const ALL = PATTERNS.map((p) => p.id);
const pairs = (m: any) =>
  [...new Set(m.scenarios.map((s: any) => `${s.flow}/${s.pattern}`))].sort();
const cartesian = (flows: string[], patterns: string[]) =>
  flows.flatMap((f) => patterns.map((p) => `${f}/${p}`)).sort();

describe('budgets (SC2)', () => {
  it('whisper is exactly the top 3 flows x the core patterns x i1', () => {
    const m = buildMatrix({
      flows: flows10(),
      amplitude: 'whisper',
      seed: 0,
    });
    expect(m.flows).toEqual(['f04', 'f09', 'f03']);
    expect(m.patterns).toEqual(['multi-submit', 'abandon-midflow']);
    expect(m.intensities).toEqual([1]);
    expect(m.scenarios.map((s: any) => s.id)).toEqual([
      'f04:multi-submit:i1:sdone',
      'f04:multi-submit:i1:ssave',
      'f09:multi-submit:i1:sdone',
      'f09:multi-submit:i1:ssave',
      'f03:multi-submit:i1:sdone',
      'f03:multi-submit:i1:ssave',
      'f04:abandon-midflow:i1:ssave',
      'f09:abandon-midflow:i1:ssave',
      'f03:abandon-midflow:i1:ssave',
    ]);
    expect(m.scenarios.map((s: any) => s.score)).toEqual([
      25, 25, 25, 25, 20, 20, 20, 20, 16,
    ]);
  });

  it('shout is the top 8 flows x every pattern x i1, i2', () => {
    const m = buildMatrix({
      flows: flows10(),
      amplitude: 'shout',
      seed: 0,
      target: FULL_TARGET,
    });
    const top8 = ['f04', 'f09', 'f03', 'f08', 'f02', 'f07', 'f01', 'f06'];
    expect(m.flows).toEqual(top8);
    expect(m.patterns).toEqual(ALL);
    expect(m.intensities).toEqual([1, 2]);
    expect(pairs(m)).toEqual(cartesian(top8, ALL));
    // 8 anchored steps per flow (multi-submit 2, abandon 1, stale 1,
    // duplicate-tab 2, token-expiry 1, shared-machine 1) x 8 flows x 2 rounds.
    expect(m.scenarios).toHaveLength(128);
  });

  it('scream is every flow x every pattern x i1..i3, never past the ceiling', () => {
    const m = buildMatrix({
      flows: flows10(),
      amplitude: 'scream',
      seed: 0,
      target: FULL_TARGET,
    });
    expect(m.flows).toHaveLength(10);
    expect(m.intensities).toEqual([1, 2, 3]);
    expect(m.scenarios).toHaveLength(240);
    expect(Math.max(...m.scenarios.map((s: any) => s.intensity))).toBe(3);
  });

  it('orders scenarios round by round, then by score, then by id', () => {
    const m = buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 0 });
    const rounds = m.scenarios.map((s: any) => s.intensity);
    expect(rounds).toEqual([...rounds].sort((a: number, b: number) => a - b));
    expect(m.scenarios[0].id).toBe('f04:multi-submit:i1:sdone');
  });

  it('exposes the three documented budgets and no others', () => {
    expect(Object.keys(AMPLITUDES)).toEqual(['whisper', 'shout', 'scream']);
    expect(() =>
      buildMatrix({ flows: flows10(), amplitude: 'loud', seed: 0 }),
    ).toThrow('unknown amplitude: loud');
  });
});

describe('applicability (SC3)', () => {
  const scream = (target: any = FULL_TARGET, flows = flows10()) =>
    buildMatrix({ flows, amplitude: 'scream', seed: 0, target });

  it('anchors every pattern only on a step it applies to', () => {
    const byId = new Map<string, any>(
      flows10()[0].steps.map((s: any, i: number) => [s.id, { ...s, i }]),
    );
    for (const s of scream().scenarios) {
      const step = byId.get(s.step)!;
      const rule: Record<string, boolean> = {
        'multi-submit': step.writes === true,
        'abandon-midflow': step.writes === true && step.i < 2,
        'stale-optimistic': typeof step.awaitResponse === 'string',
        'duplicate-tab': step.writes === true,
        'token-expiry': step.id === 'save',
        'shared-machine': step.id === 'done',
      };
      expect(rule[s.pattern], s.id).toBe(true);
    }
  });

  it('schedules nothing against a flow with no writes and no awaited response', () => {
    const readOnly = [
      {
        id: 'browse',
        risk: 5,
        steps: [{ id: 'open', action: 'goto', url: '/' }],
      },
    ];
    const m = buildMatrix({ flows: readOnly, amplitude: 'shout', seed: 0 });
    expect(m.scenarios).toEqual([]);
  });

  it('needs session keys for token-expiry and accounts A and B for shared-machine', () => {
    const onlyA = {
      name: 't',
      spec: {
        accounts: { A: { env: 'CRY_A' } },
        auth: { signIn: 'f00', signOut: 'f01', sessionKeys: [] },
      },
    };
    const patterns = new Set(
      scream(onlyA).scenarios.map((s: any) => s.pattern),
    );
    expect(patterns.has('token-expiry')).toBe(false);
    expect(patterns.has('shared-machine')).toBe(false);
    expect(patterns.has('multi-submit')).toBe(true);
  });

  it('does not read an inherited key as a declared account', () => {
    const inherited = {
      name: 't',
      spec: { accounts: {}, auth: { sessionKeys: ['cookie:s'] } },
    };
    Object.setPrototypeOf(inherited.spec.accounts, { A: {}, B: {} });
    const patterns = new Set(
      scream(inherited).scenarios.map((s: any) => s.pattern),
    );
    expect(patterns.has('shared-machine')).toBe(false);
  });

  it('lists the target-scoped patterns it left out when no target is named', () => {
    const m = buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 0 });
    expect(m.unscheduled).toEqual([
      { pattern: 'token-expiry', reason: 'no --target' },
      { pattern: 'shared-machine', reason: 'no --target' },
    ]);
    expect(m.scenarios.some((s: any) => s.pattern === 'token-expiry')).toBe(
      false,
    );
    const whisper = buildMatrix({
      flows: flows10(),
      amplitude: 'whisper',
      seed: 0,
    });
    expect(whisper.unscheduled).toEqual([]);
  });
});

describe('critical-areas ranking (SC4)', () => {
  const twoFlows = () => [
    { ...flows10()[3], id: 'aa' }, // risk 4, not critical
    { ...flows10()[3], id: 'zz', criticalArea: 'src/checkout' }, // risk 4
  ];

  it('says ranking: declared when no critical areas are given', () => {
    const m = buildMatrix({
      flows: twoFlows(),
      amplitude: 'whisper',
      seed: 0,
    });
    expect(m.ranking).toBe('declared');
    expect(m.flows).toEqual(['aa', 'zz']);
  });

  it('boosts a flow by 2 when a high-risk area lies under its criticalArea', () => {
    const areas = [{ path: 'src/checkout/pay.ts', risk_score: 0.9 }];
    const m = buildMatrix({
      flows: twoFlows(),
      amplitude: 'whisper',
      seed: 0,
      areas,
    });
    expect(m.ranking).toBe('declared+critical-areas');
    expect(m.flows).toEqual(['zz', 'aa']);
    expect(m.scenarios[0]).toMatchObject({ flow: 'zz', score: 22 });
  });

  it.each([
    ['below the 0.7 cut', { path: 'src/checkout/pay.ts', risk_score: 0.69 }],
    ['a sibling prefix', { path: 'src/checkoutx/pay.ts', risk_score: 0.9 }],
  ])('does not boost for %s, but still reports the source', (_l, area) => {
    const m = buildMatrix({
      flows: twoFlows(),
      amplitude: 'whisper',
      seed: 0,
      areas: [area],
    });
    expect(m.ranking).toBe('declared+critical-areas');
    expect(m.flows).toEqual(['aa', 'zz']);
  });
});

describe('determinism (SC1) and abstention (SC24)', () => {
  it('serializes equal input to byte-identical JSON', () => {
    const a = matrixJson(
      buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 9 }),
    );
    const b = matrixJson(
      buildMatrix({ flows: flows10(), amplitude: 'shout', seed: 9 }),
    );
    expect(a).toBe(b);
    expect(JSON.parse(a).format).toBe('canary.cry-matrix/1');
  });

  it('records the seed without letting it select scenarios', () => {
    const at = (seed: number) =>
      buildMatrix({ flows: flows10(), amplitude: 'shout', seed });
    expect(at(1).seed).toBe(1);
    expect(at(1).scenarios).toEqual(at(2).scenarios);
  });

  it('reads no clock and no randomness', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random read');
    });
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now read');
    });
    expect(() =>
      buildMatrix({ flows: flows10(), amplitude: 'scream', seed: 0 }),
    ).not.toThrow();
  });

  it('abstains on zero scenarios instead of returning an empty pass', () => {
    const m = buildMatrix({ flows: [], amplitude: 'whisper', seed: 0 });
    expect(m).toMatchObject({
      status: 'abstained',
      reason: 'zero scenarios',
      scenarios: [],
    });
    const ok = buildMatrix({
      flows: flows10(),
      amplitude: 'whisper',
      seed: 0,
    });
    expect(ok).toMatchObject({ status: 'ok', reason: null });
  });
});
