/**
 * canary-cry checkpoints, --max-wall and --resume (#608 P4, spec "Verdicts and
 * convergence" and "Failure modes"; SC18 at the module, injected clock).
 *
 * Everything here is a pure decision over documents and an injected clock:
 * the caller reads and writes checkpoint.json and maps `exit` to the process
 * exit code. That the CLI actually stops sending scenarios at the deadline,
 * writes the file, and exits with these codes is proven only once it is wired
 * into P3's executor.
 */
import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_FORMAT,
  deadlineAt,
  newCheckpoint,
  parseMaxWall,
  partialLine,
  planResume,
  recordResult,
  wallExpired,
} from '../claude-code/canary-cry/scripts/checkpoint.mjs';
import {
  decideRound,
  planRounds,
} from '../claude-code/canary-cry/scripts/convergence.mjs';

const RUN_ID = '20261125T143333Z-0123abcd';
const SHA = '0123abcd'.padEnd(64, 'e');
const OTHER_SHA = 'f'.repeat(64);
const IDS = ['f1:p:i1:sa', 'f1:p:i1:sb', 'f1:p:i2:sa', 'f1:p:i2:sb'];

const clean = (id: string) => ({ id, verdict: 'clean', fingerprints: [] });
const fresh = () =>
  newCheckpoint({ runId: RUN_ID, manifestSha: SHA, total: IDS.length });

/** A checkpoint with the first `n` scenario ids completed, clean. */
function afterScenarios(n: number) {
  return IDS.slice(0, n).reduce(
    (cp, id) => recordResult(cp, clean(id)),
    fresh(),
  );
}

const resume = (overrides: Record<string, unknown> = {}) =>
  planResume({
    runId: RUN_ID,
    checkpoint: afterScenarios(2),
    rebuiltSha: SHA,
    confirm: SHA,
    scenarioIds: IDS,
    ...overrides,
  });

describe('the checkpoint document', () => {
  it('is versioned and carries the run id, manifest sha and total', () => {
    expect(fresh()).toEqual({
      format: CHECKPOINT_FORMAT,
      runId: RUN_ID,
      manifestSha: SHA,
      total: 4,
      results: [],
    });
    expect(CHECKPOINT_FORMAT).toBe('canary.cry-checkpoint/1');
  });

  it('records a result without mutating the checkpoint it was given', () => {
    const cp = fresh();
    const next = recordResult(cp, clean(IDS[0]));
    expect(cp.results).toEqual([]);
    expect(next.results).toEqual([clean(IDS[0])]);
  });

  it('a re-recorded id replaces its earlier result rather than counting twice', () => {
    const cp = recordResult(afterScenarios(1), {
      id: IDS[0],
      verdict: 'symptom',
      fingerprints: ['f1:p:signal=pageerror'],
    });
    expect(cp.results).toHaveLength(1);
    expect(cp.results[0].verdict).toBe('symptom');
  });

  it('survives a JSON round trip unchanged (the caller writes it as JSON)', () => {
    const cp = afterScenarios(3);
    expect(JSON.parse(JSON.stringify(cp))).toEqual(cp);
  });
});

describe('--max-wall (spec Failure modes: malformed -> exit 2)', () => {
  it.each([
    ['90s', 90_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['1h30m', 5_400_000],
    ['1h30m15s', 5_415_000],
  ])('parses %s', (text, ms) => {
    expect(parseMaxWall(text)).toEqual({ ms, error: null });
  });

  it.each([
    '',
    '30',
    '1.5h',
    '-5m',
    '30M',
    '30m1h',
    '1h1h',
    'm',
    ' 30m',
    '0s',
    '0h0m',
    'abc',
  ])('refuses %j with a usage error, never a throw', (text) => {
    const r = parseMaxWall(text);
    expect(r.ms).toBeNull();
    expect(r.error).toMatch(/^--max-wall: malformed duration/);
  });

  it('refuses a duration too large to be an exact millisecond count', () => {
    expect(parseMaxWall('9'.repeat(20) + 'h').error).toMatch(/malformed/);
  });

  it('refuses a non-string (an absent flag value) as a usage error', () => {
    expect(parseMaxWall(undefined).error).toMatch(/malformed/);
  });
});

describe('the deadline (SC18, injected clock)', () => {
  const START = 1_000_000;

  it('has no deadline without --max-wall, so it never expires', () => {
    const deadline = deadlineAt(START, null);
    expect(deadline).toBeNull();
    expect(wallExpired(deadline, () => Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('expires exactly when the injected clock reaches start + max-wall', () => {
    const deadline = deadlineAt(START, 90_000);
    expect(wallExpired(deadline, () => START + 89_999)).toBe(false);
    expect(wallExpired(deadline, () => START + 90_000)).toBe(true);
  });

  it('on expiry the checkpoint names n/m and the resume path', () => {
    const deadline = deadlineAt(START, 90_000);
    const cp = afterScenarios(2);
    expect(wallExpired(deadline, () => START + 90_000)).toBe(true);
    expect(partialLine(cp)).toBe(
      `PARTIAL: 2/4 — resume with --resume ${RUN_ID}`,
    );
  });
});

describe('planResume (SC18)', () => {
  it('skips the completed ids and hands back their results', () => {
    const plan = resume();
    expect(plan).toMatchObject({ exit: null, reason: null });
    expect(plan.remaining).toEqual(IDS.slice(2));
    expect(plan.results.map((r: any) => r.id)).toEqual(IDS.slice(0, 2));
  });

  it('a rebuilt manifest that differs from the checkpoint is refused, exit 4', () => {
    const plan = resume({ rebuiltSha: OTHER_SHA, confirm: OTHER_SHA });
    expect(plan.exit).toBe(4);
    expect(plan.reason).toMatch(/manifest changed since run/);
    expect(plan.remaining).toEqual([]);
  });

  it('a --confirm that does not match the rebuilt manifest is refused, exit 4', () => {
    const plan = resume({ confirm: OTHER_SHA });
    expect(plan.exit).toBe(4);
    expect(plan.reason).toMatch(/manifest-sha mismatch/);
  });

  it('an unknown run id (no checkpoint found) is a usage error, exit 2', () => {
    const plan = resume({ checkpoint: null });
    expect(plan).toMatchObject({ exit: 2, remaining: [] });
    expect(plan.reason).toBe(`--resume: unknown run-id: ${RUN_ID}`);
  });

  it.each(['../../etc', 'latest', '20261125T143333Z', ''])(
    'a run id not in the run-id shape (%j) is refused before any lookup, exit 2',
    (runId) => {
      expect(resume({ runId }).exit).toBe(2);
    },
  );

  it('a checkpoint of another format or run is refused, exit 2', () => {
    const wrongFormat = {
      ...afterScenarios(1),
      format: 'canary.cry-checkpoint/9',
    };
    expect(resume({ checkpoint: wrongFormat }).exit).toBe(2);
    const otherRun = {
      ...afterScenarios(1),
      runId: '20261125T000000Z-ffffffff',
    };
    expect(resume({ checkpoint: otherRun }).exit).toBe(2);
    expect(resume({ checkpoint: { format: CHECKPOINT_FORMAT } }).exit).toBe(2);
  });
});

describe('deadline -> checkpoint -> resume -> convergence, end to end (pure)', () => {
  it('a resumed run continues the round it stopped in, then stops at budget', () => {
    const matrix = {
      amplitude: 'shout',
      intensities: [1, 2],
      scenarios: IDS.map((id) => ({
        id,
        intensity: Number(id.split(':i')[1][0]),
      })),
    };
    const rounds = planRounds(matrix);
    let cp = fresh();
    const clock = { now: 0 };
    const deadline = deadlineAt(0, 3_000);
    const executed: string[] = [];
    for (const id of IDS) {
      if (wallExpired(deadline, () => clock.now)) break;
      executed.push(id);
      cp = recordResult(cp, clean(id));
      clock.now += 1_000;
    }
    expect(executed).toEqual(IDS.slice(0, 3));
    expect(partialLine(cp)).toBe(
      `PARTIAL: 3/4 — resume with --resume ${RUN_ID}`,
    );

    const stored = JSON.parse(JSON.stringify(cp));
    const plan = resume({ checkpoint: stored });
    expect(plan.remaining).toEqual([IDS[3]]);
    const next = decideRound({
      amplitude: 'shout',
      rounds,
      results: plan.results,
    });
    expect(next).toMatchObject({
      status: 'run',
      intensity: 2,
      pending: [IDS[3]],
    });
    const done = decideRound({
      amplitude: 'shout',
      rounds,
      results: [...plan.results, clean(IDS[3])],
    });
    expect(done).toMatchObject({ status: 'done', reason: 'budget' });
  });
});
