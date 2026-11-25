/**
 * canary-cry verdicts (#608 P3, spec "Verdicts and convergence", D3). Pure:
 * the runtime evaluates each scenario with these functions inside the
 * browser run, and the executor folds them into the run's status and exit
 * code, so one module decides what a finding is.
 *
 * - SC15 a run in which nothing was probed is ABSTAINED, and --strict exits 3
 * - SC16 under --strict, symptom-only exits 0 and >= 1 corrupted exits 1
 * - SC21 a probe error is `abstain: probe-failed@<invariant>`, never clean
 */
import { describe, expect, it } from 'vitest';

import {
  checkExpect,
  scenarioVerdict,
  summarize,
} from '../claude-code/canary-cry/scripts/verdict.mjs';
import { exitCode } from '../claude-code/canary-cry/scripts/findings.mjs';

const base = { flow: 'checkout', pattern: 'multi-submit', brokenAt: null };

const verdictOf = (over: Record<string, unknown>) =>
  scenarioVerdict({ ...base, invariants: [], signals: [], ...over });

describe('checkExpect', () => {
  it.each<[any, unknown, unknown, any]>([
    [{ delta: 1 }, 0, 1, { breached: false }],
    [{ delta: 1 }, 0, 2, { breached: true }],
    [{ delta: 0 }, 3, 3, { breached: false }],
    [{ equals: 1 }, 9, 1, { breached: false }],
    [{ equals: { a: [1, 2] } }, null, { a: [1, 2] }, { breached: false }],
    [{ equals: { a: 1, b: 2 } }, null, { b: 2, a: 1 }, { breached: false }],
    [{ equals: 'x' }, null, 'y', { breached: true }],
  ])('%j over %j -> %j is %j', (exp, before, after, want) => {
    expect(checkExpect(exp, before, after)).toEqual(want);
  });

  // #1720: a pattern whose abuse a correct app answers by refusing the flow
  // (token-expiry) passes when the app refused cleanly OR completed exactly
  // once. A partial or a double write is still a breach.
  it.each<[string, any, unknown, unknown, boolean]>([
    ['refused: no change', { delta: 2 }, 5, 5, false],
    ['completed exactly once', { delta: 2 }, 5, 7, false],
    ['a partial write', { delta: 2 }, 5, 6, true],
    ['a double write', { delta: 2 }, 5, 9, true],
    ['a negative change', { delta: 2 }, 5, 4, true],
    ['equals: completed', { equals: 'paid' }, 'open', 'paid', false],
    ['equals: refused, unchanged', { equals: 'paid' }, 'open', 'open', false],
    ['equals: neither', { equals: 'paid' }, 'open', 'void', true],
    [
      'equals: refused, key order',
      { equals: 1 },
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      false,
    ],
  ])('mayRefuse, %s', (_, exp, before, after, breached) => {
    expect(checkExpect(exp, before, after, { mayRefuse: true })).toEqual({
      breached,
    });
  });

  it.each<[string, any, unknown, unknown]>([
    ['delta', { delta: 1 }, 3, 3],
    ['equals', { equals: 'paid' }, 'open', 'open'],
  ])(
    'without mayRefuse, an unchanged %s value is still a breach',
    (_, exp, before, after) => {
      expect(checkExpect(exp, before, after)).toEqual({ breached: true });
      expect(checkExpect(exp, before, after, { mayRefuse: false })).toEqual({
        breached: true,
      });
    },
  );

  it('mayRefuse does not excuse a delta over a non-number', () => {
    expect(checkExpect({ delta: 1 }, '0', 1, { mayRefuse: true })).toEqual({
      error: 'delta needs numbers, got string before and number after',
    });
  });

  it('a delta over a non-number is an error, never a guess', () => {
    expect(checkExpect({ delta: 1 }, '0', 1)).toEqual({
      error: 'delta needs numbers, got string before and number after',
    });
  });
});

describe('scenarioVerdict (the D3 fidelity ladder)', () => {
  it('a breached invariant is corrupted, state-verified', () => {
    const v = verdictOf({
      invariants: [
        { id: 'one-order', breached: true },
        { id: 'one-row', breached: false },
      ],
    });
    expect(v).toEqual({
      verdict: 'corrupted',
      reason: null,
      fidelity: 'state-verified',
      fingerprints: ['checkout:multi-submit:one-order'],
    });
  });

  it('a corrupted scenario also fingerprints its UI signals', () => {
    const v = verdictOf({
      invariants: [{ id: 'one-order', breached: true }],
      signals: [{ kind: 'http-5xx' }, { kind: 'http-5xx' }],
    });
    expect(v.fingerprints).toEqual([
      'checkout:multi-submit:one-order',
      'checkout:multi-submit:http-5xx',
    ]);
  });

  it('no breach and a UI signal is a symptom, observed', () => {
    const v = verdictOf({
      invariants: [{ id: 'one-order', breached: false }],
      signals: [{ kind: 'pageerror' }, { kind: 'selector' }],
    });
    expect(v).toEqual({
      verdict: 'symptom',
      reason: null,
      fidelity: 'observed',
      fingerprints: [
        'checkout:multi-submit:pageerror',
        'checkout:multi-submit:selector',
      ],
    });
  });

  it('a UI signal on a flow with no invariants is still a symptom', () => {
    expect(verdictOf({ signals: [{ kind: 'cross-account-leak' }] })).toEqual(
      expect.objectContaining({ verdict: 'symptom' }),
    );
  });

  it('checked, unbreached and quiet is clean', () => {
    const v = verdictOf({ invariants: [{ id: 'one-order', breached: false }] });
    expect(v).toEqual({
      verdict: 'clean',
      reason: null,
      fidelity: 'state-verified',
      fingerprints: [],
    });
  });

  it('no invariant and no signal abstains: no-probes', () => {
    expect(verdictOf({})).toEqual({
      verdict: 'abstain',
      reason: 'no-probes',
      fidelity: null,
      fingerprints: [],
    });
  });

  it('a probe error abstains, never clean (SC21)', () => {
    const v = verdictOf({
      invariants: [
        { id: 'one-row', breached: false },
        { id: 'one-order', error: 'HTTP 500' },
      ],
    });
    expect(v.verdict).toBe('abstain');
    expect(v.reason).toBe('probe-failed@one-order');
  });

  it('a probe error outranks a symptom: the state is unknown', () => {
    const v = verdictOf({
      invariants: [{ id: 'one-order', error: 'jsonPath $.n is absent' }],
      signals: [{ kind: 'pageerror' }],
    });
    expect(v.reason).toBe('probe-failed@one-order');
  });

  it('a breach is still corrupted beside another probe error', () => {
    const v = verdictOf({
      invariants: [
        { id: 'one-order', breached: true },
        { id: 'one-row', error: 'exit 1' },
      ],
    });
    expect(v.verdict).toBe('corrupted');
  });

  it('a step failing before the abuse point is flow-broken, never a finding (SC14)', () => {
    const v = verdictOf({
      brokenAt: 'card',
      invariants: [{ id: 'one-order', breached: true }],
      signals: [{ kind: 'pageerror' }],
    });
    expect(v).toEqual({
      verdict: 'abstain',
      reason: 'flow-broken@card',
      fidelity: null,
      fingerprints: [],
    });
  });
});

const sc = (verdict: string, reason: string | null = null) => ({
  verdict,
  reason,
});

describe('summarize', () => {
  it('counts every verdict', () => {
    const s = summarize([sc('corrupted'), sc('clean'), sc('clean')]);
    expect(s).toEqual({
      status: 'ok',
      reason: null,
      counts: { corrupted: 1, symptom: 0, clean: 2, abstain: 0 },
    });
  });

  it('a run in which every scenario abstained is ABSTAINED, reasons counted (SC15)', () => {
    const s = summarize([
      sc('abstain', 'no-probes'),
      sc('abstain', 'flow-broken@card'),
      sc('abstain', 'no-probes'),
    ]);
    expect(s.status).toBe('abstained');
    expect(s.reason).toBe(
      'every scenario abstained (no-probes 2, flow-broken@card 1)',
    );
  });

  it('zero scenarios is ABSTAINED, not a pass', () => {
    expect(summarize([]).reason).toBe('zero scenarios');
  });

  it('one probed scenario among abstentions is not ABSTAINED', () => {
    expect(summarize([sc('abstain', 'no-probes'), sc('clean')]).status).toBe(
      'ok',
    );
  });
});

describe('exitCode (SC15, SC16)', () => {
  const counts = (over: Record<string, number>) => ({
    status: 'ok',
    reason: null,
    counts: { corrupted: 0, symptom: 0, clean: 0, abstain: 0, ...over },
  });

  it('advisory by default, whatever was found', () => {
    expect(exitCode(counts({ corrupted: 3 }), false)).toBe(0);
    expect(exitCode({ ...counts({}), status: 'abstained' }, false)).toBe(0);
  });

  it('--strict: symptom only exits 0, never fails a build', () => {
    expect(exitCode(counts({ symptom: 4, clean: 1 }), true)).toBe(0);
  });

  it('--strict: one corrupted exits 1', () => {
    expect(exitCode(counts({ corrupted: 1, symptom: 2 }), true)).toBe(1);
  });

  it('--strict: an ABSTAINED run exits 3', () => {
    expect(exitCode({ ...counts({}), status: 'abstained' }, true)).toBe(3);
  });

  // #608 P4: a --max-wall stop did not run its whole budget, so it is not a
  // pass -- the same exit as an abstention. A corruption it already proved
  // outranks that: it is a state-verified finding however the run ended.
  it('--strict: a PARTIAL run exits 3, or 1 once it found a corruption', () => {
    expect(exitCode({ ...counts({ clean: 2 }), status: 'partial' }, true)).toBe(
      3,
    );
    expect(
      exitCode({ ...counts({ corrupted: 1 }), status: 'partial' }, true),
    ).toBe(1);
    expect(exitCode({ ...counts({}), status: 'partial' }, false)).toBe(0);
  });

  it('--strict: a crash after a proven corruption still exits 1', () => {
    expect(
      exitCode({ ...counts({ corrupted: 1 }), status: 'abstained' }, true),
    ).toBe(1);
  });
});
