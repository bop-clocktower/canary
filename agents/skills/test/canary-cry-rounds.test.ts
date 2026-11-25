/**
 * canary-cry's round loop (#608 P4): convergence.mjs and checkpoint.mjs wired
 * to a scenario runner. Injected verdict sequences and an injected clock, so
 * these prove the loop itself -- what runs, in what order, when it stops, and
 * what it saves -- with no browser:
 *
 * - SC17 scream stops after 2 consecutive barren rounds and says
 *        `converged after round <n>`; no round above i3 ever runs
 * - SC18 --max-wall elapsing stops before the next scenario with
 *        `PARTIAL: n/m — resume with --resume <run-id>`; a checkpoint is
 *        saved after every scenario; a resumed checkpoint skips its ids and
 *        convergence continues from its results
 * - the adapter from a runtime observation to convergence's ScenarioResult
 */
import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_FORMAT,
  newCheckpoint,
  recordResult,
} from '../claude-code/canary-cry/scripts/checkpoint.mjs';
import {
  runRounds,
  toResult,
} from '../claude-code/canary-cry/scripts/rounds.mjs';

const RUN = { id: '20261125T143333Z-0123abcd', manifestSha: 'e'.repeat(64) };

/** Two scenarios per intensity, in the matrix's id shape. */
function manifest(amplitude: string, intensities: number[]): any {
  const scenarios = intensities.flatMap((n) =>
    ['a', 'b'].map((step) => ({
      id: `checkout:multi-submit:i${n}:s${step}`,
      flow: 'checkout',
      pattern: 'multi-submit',
      intensity: n,
      step,
    })),
  );
  return { amplitude, scenarios };
}

type Outcome = { result?: any; crashed?: any };

/** An observation the runtime would write; corrupted when `breach` is set. */
function observation(breach?: string) {
  if (breach === undefined) {
    return {
      verdict: 'clean',
      reason: null,
      invariants: [{ id: 'one-order', breached: false }],
      signals: [],
    };
  }
  return {
    verdict: 'corrupted',
    reason: null,
    invariants: [{ id: breach, breached: true }],
    signals: [],
  };
}

interface Harness {
  ran: string[];
  saved: any[];
  now: number;
}

/**
 * A runner over a verdict table: `breaches[id]` names the invariant that
 * scenario breaches; every other scenario is clean. Each scenario takes
 * `stepMs` of injected clock.
 */
function harness(breaches: Record<string, string> = {}, stepMs = 10_000) {
  const h: Harness = { ran: [], saved: [], now: 0 };
  return {
    h,
    runOne: async (scenario: any): Promise<Outcome> => {
      h.ran.push(scenario.id);
      h.now += stepMs;
      return { result: toResult(scenario, observation(breaches[scenario.id])) };
    },
    save: (cp: any) => h.saved.push(cp),
    clock: () => h.now,
  };
}

function rounds(m: any, t: ReturnType<typeof harness>, extra: object = {}) {
  return runRounds({
    manifest: m,
    run: RUN,
    resumed: null,
    runOne: t.runOne,
    save: t.save,
    clock: t.clock,
    maxWall: null,
    ...extra,
  });
}

const ids = (m: any, n: number) =>
  m.scenarios.filter((s: any) => s.intensity === n).map((s: any) => s.id);

describe('the rounds an amplitude runs', () => {
  it('whisper runs its one round, every scenario once, in manifest order', async () => {
    const m = manifest('whisper', [1]);
    const t = harness();
    const out = await rounds(m, t);
    expect(t.h.ran).toEqual(ids(m, 1));
    expect(out.stop).toBe('budget');
    expect(out.line).toBeNull();
  });

  it('shout runs i1 then i2, its whole budget, with no convergence claim', async () => {
    const m = manifest('shout', [1, 2]);
    const t = harness();
    const out = await rounds(m, t);
    expect(t.h.ran).toEqual([...ids(m, 1), ...ids(m, 2)]);
    expect(out.stop).toBe('budget');
    expect(out.line).toBeNull();
    expect(out.rounds.map((r: any) => r.intensity)).toEqual([1, 2]);
  });
});

describe('scream convergence (SC17)', () => {
  it('stops after two barren rounds: i3 never runs', async () => {
    const m = manifest('scream', [1, 2, 3]);
    const t = harness();
    const out = await rounds(m, t);
    expect(t.h.ran).toEqual([...ids(m, 1), ...ids(m, 2)]);
    expect(out.stop).toBe('converged');
    expect(out.line).toBe('converged after round 2');
  });

  it('a finding in round 1 only: rounds 2 and 3 are barren, converged after round 3', async () => {
    const m = manifest('scream', [1, 2, 3]);
    const t = harness({ 'checkout:multi-submit:i1:sa': 'one-order' });
    const out = await rounds(m, t);
    expect(t.h.ran).toHaveLength(6);
    expect(out.line).toBe('converged after round 3');
  });

  it('a new fingerprint in round 2 keeps it going to the ceiling, and says so', async () => {
    const m = manifest('scream', [1, 2, 3]);
    const t = harness({ 'checkout:multi-submit:i2:sb': 'one-order' });
    const out = await rounds(m, t);
    expect(t.h.ran).toHaveLength(6);
    expect(out.stop).toBe('ceiling');
    expect(out.line).toBe(
      'not converged: stopped at the intensity ceiling after round 3',
    );
  });

  it('never runs a scenario above the ceiling, whatever the manifest says', async () => {
    const m = manifest('scream', [1, 2, 3, 4]);
    const t = harness({
      'checkout:multi-submit:i2:sb': 'one-order',
      'checkout:multi-submit:i3:sb': 'two-orders',
    });
    await rounds(m, t);
    expect(t.h.ran.some((id) => id.includes(':i4:'))).toBe(false);
  });
});

describe('checkpoints and --max-wall (SC18)', () => {
  it('saves a checkpoint before the first scenario and after every one', async () => {
    const m = manifest('shout', [1, 2]);
    const t = harness();
    await rounds(m, t);
    expect(t.h.saved.map((cp) => cp.results.length)).toEqual([0, 1, 2, 3, 4]);
    expect(t.h.saved[0]).toEqual(
      expect.objectContaining({
        format: CHECKPOINT_FORMAT,
        runId: RUN.id,
        manifestSha: RUN.manifestSha,
        total: 4,
      }),
    );
  });

  it('stops before the next scenario once the wall has elapsed: PARTIAL n/m', async () => {
    const m = manifest('scream', [1, 2, 3]);
    const t = harness({}, 10_000);
    const out = await rounds(m, t, { maxWall: '25s' });
    // t=0, 10 s, 20 s start a scenario; at 30 s the wall has elapsed.
    expect(t.h.ran).toHaveLength(3);
    expect(out.stop).toBe('partial');
    expect(out.line).toBe(`PARTIAL: 3/6 — resume with --resume ${RUN.id}`);
    expect(t.h.saved.at(-1).results.map((r: any) => r.id)).toEqual(t.h.ran);
  });

  it('a wall that elapses before the first scenario is PARTIAL 0/m, never a pass', async () => {
    const m = manifest('whisper', [1]);
    const t = harness();
    // The deadline is read at 0; by the first scenario 5 s have passed.
    let reads = 0;
    const out = await rounds(m, t, {
      maxWall: '1s',
      clock: () => (reads++ === 0 ? 0 : 5_000),
    });
    expect(t.h.ran).toEqual([]);
    expect(out.line).toBe(`PARTIAL: 0/2 — resume with --resume ${RUN.id}`);
  });

  it('no --max-wall never stops on the clock', async () => {
    const m = manifest('shout', [1, 2]);
    const t = harness({}, 10 * 3_600_000);
    expect((await rounds(m, t)).stop).toBe('budget');
  });
});

describe('a resumed checkpoint (SC18)', () => {
  function resumedAfter(m: any, done: string[]) {
    return done.reduce(
      (cp, id) => recordResult(cp, { id, verdict: 'clean', fingerprints: [] }),
      newCheckpoint({
        runId: RUN.id,
        manifestSha: RUN.manifestSha,
        total: m.scenarios.length,
      }),
    );
  }

  it('skips the completed ids and keeps their results', async () => {
    const m = manifest('shout', [1, 2]);
    const t = harness();
    const done = ids(m, 1).slice(0, 1);
    const out = await rounds(m, t, { resumed: resumedAfter(m, done) });
    expect(t.h.ran).toEqual(m.scenarios.slice(1).map((s: any) => s.id));
    expect(out.checkpoint.results.map((r: any) => r.id)).toEqual(
      m.scenarios.map((s: any) => s.id),
    );
  });

  it("continues convergence from the checkpoint's results", async () => {
    const m = manifest('scream', [1, 2, 3]);
    const t = harness();
    // Round 1 was barren before the stop; one barren round 2 converges it.
    const out = await rounds(m, t, { resumed: resumedAfter(m, ids(m, 1)) });
    expect(t.h.ran).toEqual(ids(m, 2));
    expect(out.line).toBe('converged after round 2');
  });

  it('a finished checkpoint runs nothing more', async () => {
    const m = manifest('whisper', [1]);
    const t = harness();
    const out = await rounds(m, t, { resumed: resumedAfter(m, ids(m, 1)) });
    expect(t.h.ran).toEqual([]);
    expect(out.stop).toBe('budget');
  });
});

describe('a crashed scenario', () => {
  it('stops the run at once, keeping what completed before it', async () => {
    const m = manifest('shout', [1, 2]);
    const t = harness();
    let calls = 0;
    const crash = { code: 1, stderr: ['boom'] };
    const out = await rounds(m, t, {
      runOne: async (s: any): Promise<Outcome> =>
        (calls += 1) === 2 ? { crashed: crash } : t.runOne(s),
    });
    expect(out.stop).toBe('crashed');
    expect(out.crash).toBe(crash);
    expect(out.checkpoint.results).toHaveLength(1);
  });
});

describe('toResult: an observation as convergence reads it', () => {
  const scenario = {
    id: 'checkout:multi-submit:i2:spay',
    flow: 'checkout',
    pattern: 'multi-submit',
  };

  it('a corrupted scenario: one fingerprint per breach and per signal kind', () => {
    const r = toResult(scenario, {
      verdict: 'corrupted',
      reason: null,
      invariants: [
        { id: 'one-order', breached: true },
        { id: 'one-address', breached: false },
      ],
      signals: [{ kind: 'pageerror' }, { kind: 'pageerror' }],
    });
    expect(r).toEqual({
      id: scenario.id,
      verdict: 'corrupted',
      fingerprints: [
        'checkout:multi-submit:invariant=one-order',
        'checkout:multi-submit:signal=pageerror',
      ],
    });
  });

  it('a symptom: its signal kinds only', () => {
    const r = toResult(scenario, {
      verdict: 'symptom',
      reason: null,
      invariants: [{ id: 'one-order', breached: false }],
      signals: [{ kind: 'cross-account-leak', field: 'account.A.email' }],
    });
    expect(r.fingerprints).toEqual([
      'checkout:multi-submit:signal=cross-account-leak',
    ]);
  });

  it('clean and abstained scenarios find nothing; an abstention keeps its reason', () => {
    expect(toResult(scenario, observation()).fingerprints).toEqual([]);
    const broken = toResult(scenario, {
      verdict: 'abstain',
      reason: 'flow-broken@card',
      invariants: [],
      signals: [{ kind: 'pageerror' }],
    });
    expect(broken).toEqual({
      id: scenario.id,
      verdict: 'abstain: flow-broken@card',
      fingerprints: [],
    });
  });

  it('no observation is an abstention, never a clean', () => {
    expect(toResult(scenario, null)).toEqual({
      id: scenario.id,
      verdict: 'abstain: no-observation',
      fingerprints: [],
    });
  });
});
