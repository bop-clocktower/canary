/**
 * canary-cry rounds and convergence (#608 P4, spec D5 and "Verdicts and
 * convergence"; SC17 at the module, injected verdict sequences).
 *
 * The executor does not exist on this branch: every result below is an
 * injected `{ id, verdict, fingerprints }` record, the module's whole input
 * contract. What these tests prove is the decision -- which round runs next,
 * when a scream run stops, and the line it prints. That the executor feeds
 * the decision real verdicts and actually stops sending scenarios is proven
 * only once it is wired (P4 integration, after P3).
 */
import { describe, expect, it } from 'vitest';

import {
  ROUND_CEILING,
  decideRound,
  fingerprint,
  planRounds,
} from '../claude-code/canary-cry/scripts/convergence.mjs';
import { buildMatrix } from '../claude-code/canary-cry/scripts/matrix.mjs';
import { INTENSITY_CEILING } from '../claude-code/canary-cry/scripts/patterns.mjs';

type Result = { id: string; verdict: string; fingerprints: string[] };

/** Two scenarios per round, ids in the matrix's own shape. */
const ids = (n: number) => [
  `f1:multi-submit:i${n}:ssave`,
  `f2:multi-submit:i${n}:ssave`,
];

function forgedMatrix(amplitude: string, intensities: number[]): any {
  const scenarios = intensities.flatMap((n) =>
    ids(n).map((id) => ({ id, intensity: n })),
  );
  return { amplitude, intensities, scenarios };
}

const clean = (id: string): Result => ({
  id,
  verdict: 'clean',
  fingerprints: [],
});
const corrupted = (id: string, fp: string): Result => ({
  id,
  verdict: 'corrupted',
  fingerprints: [fp],
});
const abstain = (id: string): Result => ({
  id,
  verdict: 'abstain: no-probes',
  fingerprints: [],
});

const barrenRound = (n: number) => ids(n).map(clean);
const FP_A = fingerprint({
  flow: 'f1',
  pattern: 'multi-submit',
  invariant: 'one-order',
});
const FP_B = fingerprint({
  flow: 'f2',
  pattern: 'multi-submit',
  signal: 'pageerror',
});

function decide(amplitude: string, intensities: number[], results: Result[]) {
  const matrix = forgedMatrix(amplitude, intensities);
  return decideRound({ amplitude, rounds: planRounds(matrix), results });
}

describe('fingerprint (spec: flow + pattern + invariant id or UI-signal kind)', () => {
  it('is built from flow, pattern and the invariant id', () => {
    expect(FP_A).toBe('f1:multi-submit:invariant=one-order');
  });

  it('is built from flow, pattern and the UI-signal kind', () => {
    expect(FP_B).toBe('f2:multi-submit:signal=pageerror');
  });

  it('never lets an invariant named like a signal kind collide with it', () => {
    const inv = fingerprint({
      flow: 'f',
      pattern: 'p',
      invariant: 'pageerror',
    });
    const sig = fingerprint({ flow: 'f', pattern: 'p', signal: 'pageerror' });
    expect(inv).not.toBe(sig);
  });

  it('needs exactly one of invariant or signal', () => {
    expect(() => fingerprint({ flow: 'f', pattern: 'p' })).toThrow(
      /exactly one of invariant or signal/,
    );
    expect(() =>
      fingerprint({ flow: 'f', pattern: 'p', invariant: 'x', signal: 'y' }),
    ).toThrow(/exactly one of invariant or signal/);
  });
});

describe('planRounds', () => {
  it('pins the ceiling to the pattern catalog (one source of truth, tested)', () => {
    expect(ROUND_CEILING).toBe(INTENSITY_CEILING);
  });

  it('groups a real scream matrix into rounds i1, i2, i3 in order', () => {
    const flows = [
      {
        id: 'f1',
        risk: 3,
        steps: [{ id: 'save', action: 'click', selector: '#s', writes: true }],
      },
    ];
    const matrix = buildMatrix({ flows, amplitude: 'scream', seed: 0 });
    const rounds = planRounds(matrix);
    expect(rounds.map((r: any) => r.intensity)).toEqual([1, 2, 3]);
    const all = rounds.flatMap((r: any) => r.ids);
    expect(all.sort()).toEqual(matrix.scenarios.map((s: any) => s.id).sort());
    for (const r of rounds) {
      expect(
        r.ids.every((id: string) => id.includes(`:i${r.intensity}:`)),
      ).toBe(true);
    }
  });

  it('never plans a round above the ceiling, even from a forged matrix (SC17)', () => {
    const rounds = planRounds(forgedMatrix('scream', [1, 2, 3, 4, 5]));
    expect(rounds.map((r: any) => r.intensity)).toEqual([1, 2, 3]);
  });
});

describe('decideRound: scream (SC17)', () => {
  it('starts at i1 with every i1 id pending', () => {
    expect(decide('scream', [1, 2, 3], [])).toMatchObject({
      status: 'run',
      intensity: 1,
      pending: ids(1),
    });
  });

  it('stops after two consecutive barren rounds and prints the line', () => {
    const d = decide(
      'scream',
      [1, 2, 3],
      [...barrenRound(1), ...barrenRound(2)],
    );
    expect(d).toMatchObject({
      status: 'done',
      reason: 'converged',
      line: 'converged after round 2',
    });
    expect(d.rounds.map((r: any) => r.barren)).toEqual([true, true]);
  });

  it('a round repeating only already-seen fingerprints is barren', () => {
    const [a1, b1] = ids(1);
    const [a2, b2] = ids(2);
    const [a3, b3] = ids(3);
    const results = [
      corrupted(a1, FP_A),
      clean(b1),
      corrupted(a2, FP_A),
      clean(b2),
      corrupted(a3, FP_A),
      clean(b3),
    ];
    const d = decide('scream', [1, 2, 3], results);
    expect(d.rounds.map((r: any) => r.fresh)).toEqual([[FP_A], [], []]);
    expect(d).toMatchObject({
      reason: 'converged',
      line: 'converged after round 3',
    });
  });

  it('runs the next round while a round still adds fingerprints', () => {
    const [a1, b1] = ids(1);
    const d = decide('scream', [1, 2, 3], [corrupted(a1, FP_A), clean(b1)]);
    expect(d).toMatchObject({ status: 'run', intensity: 2, pending: ids(2) });
  });

  it('stops at the ceiling, with no convergence claim, when no round is barren twice', () => {
    const [a1, b1] = ids(1);
    const [a2, b2] = ids(2);
    const results = [
      corrupted(a1, FP_A),
      clean(b1),
      corrupted(a2, FP_B),
      clean(b2),
      ...barrenRound(3),
    ];
    const d = decide('scream', [1, 2, 3, 4], results);
    expect(d).toMatchObject({ status: 'done', reason: 'ceiling', line: null });
    expect(d.rounds.map((r: any) => r.intensity)).toEqual([1, 2, 3]);
  });

  it('an all-abstained round is not evidence: it breaks a barren streak', () => {
    const results = [
      ...barrenRound(1),
      ...ids(2).map(abstain),
      ...barrenRound(3),
    ];
    const d = decide('scream', [1, 2, 3], results);
    expect(d.rounds.map((r: any) => r.barren)).toEqual([true, false, true]);
    expect(d.rounds[1].abstained).toBe(true);
    expect(d).toMatchObject({ reason: 'ceiling', line: null });
  });

  it('resumes inside a round: only the ids without a result are pending', () => {
    const [a2, b2] = ids(2);
    const d = decide('scream', [1, 2, 3], [...barrenRound(1), clean(a2)]);
    expect(d).toMatchObject({ status: 'run', intensity: 2, pending: [b2] });
  });

  it('a result for an id outside the plan changes nothing', () => {
    const stray = clean('f9:multi-submit:i1:sx');
    expect(decide('scream', [1, 2, 3], [stray])).toMatchObject({
      status: 'run',
      intensity: 1,
      pending: ids(1),
    });
  });
});

describe('decideRound: whisper and shout run their whole budget', () => {
  it('whisper is one round and makes no convergence claim', () => {
    const d = decide('whisper', [1], barrenRound(1));
    expect(d).toMatchObject({ status: 'done', reason: 'budget', line: null });
  });

  it('shout runs i1 then i2 even when i1 is barren', () => {
    expect(decide('shout', [1, 2], barrenRound(1))).toMatchObject({
      status: 'run',
      intensity: 2,
    });
  });

  it('shout never claims convergence, even with two barren rounds', () => {
    const d = decide('shout', [1, 2], [...barrenRound(1), ...barrenRound(2)]);
    expect(d).toMatchObject({ status: 'done', reason: 'budget', line: null });
  });

  it('a matrix with no rounds is done at once (the caller has already abstained)', () => {
    const d = decideRound({ amplitude: 'whisper', rounds: [], results: [] });
    expect(d).toMatchObject({ status: 'done', reason: 'budget', rounds: [] });
  });
});
