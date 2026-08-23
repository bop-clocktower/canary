/**
 * The verdict model's one structural invariant: `abstain` and `no-probe` are
 * separate values. Collapsing them would hide whether a file suffers a probe
 * that could not decide or a registry with no probe at all (spec D3).
 */
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_STATUSES,
  tallyVerdicts,
  type ExerciseVerdict,
} from '../src/analysis/batwoman/verdict.js';

describe('exercise statuses', () => {
  it('names exactly the five statuses the spec defines', () => {
    expect([...EXERCISE_STATUSES]).toEqual([
      'exercised',
      'not-exercised',
      'abstain',
      'no-probe',
      'not-applicable',
    ]);
  });

  it('keeps abstain and no-probe as distinct values', () => {
    expect(new Set(EXERCISE_STATUSES).size).toBe(EXERCISE_STATUSES.length);
    expect(EXERCISE_STATUSES).toContain('abstain');
    expect(EXERCISE_STATUSES).toContain('no-probe');
  });
});

function v(file: string, status: ExerciseVerdict['status']): ExerciseVerdict {
  return { file, status, explanation: `${file} is ${status}.` };
}

describe('tallyVerdicts', () => {
  const mixed = [
    v('a.yml', 'not-exercised'),
    v('b.mjs', 'not-exercised'),
    v('c.ts', 'no-probe'),
    v('d.ts', 'abstain'),
    v('e.md', 'not-applicable'),
    v('f.yml', 'exercised'),
  ];

  it('counts every status and the changed-file total', () => {
    const tally = tallyVerdicts(mixed);
    expect(tally.changed).toBe(6);
    expect(tally.byStatus).toEqual({
      exercised: 1,
      'not-exercised': 2,
      abstain: 1,
      'no-probe': 1,
      'not-applicable': 1,
    });
  });

  it('sums the five counts to the changed-file total', () => {
    const tally = tallyVerdicts(mixed);
    const sum = Object.values(tally.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(tally.changed);
  });

  it('exposes no derived "assessed" figure to fold abstentions into', () => {
    // spec criterion 3: a file batwoman could not decide about must not be
    // countable among those it decided. The guard is structural -- there is no
    // field an aggregate could arrive in.
    const tally = tallyVerdicts(mixed) as Record<string, unknown>;
    expect(Object.keys(tally).sort()).toEqual(['byStatus', 'changed']);
    for (const forbidden of ['assessed', 'decided', 'covered', 'clean']) {
      expect(tally[forbidden]).toBeUndefined();
    }
  });

  it('tallies an empty run without inventing a denominator', () => {
    const tally = tallyVerdicts([]);
    expect(tally.changed).toBe(0);
    expect(tally.byStatus.exercised).toBe(0);
  });
});
