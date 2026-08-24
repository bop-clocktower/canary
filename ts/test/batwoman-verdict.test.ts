/**
 * The verdict model's one structural invariant: `abstain` and `no-probe` are
 * separate values. Collapsing them would hide whether a file suffers a probe
 * that could not decide or a registry with no probe at all (spec D3).
 */
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_STATUSES,
  EmptyExplanationError,
  explain,
  isExplanation,
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

describe('explain', () => {
  it('refuses the empty string, so an empty row cannot be constructed', () => {
    expect(() => explain('')).toThrow(EmptyExplanationError);
  });

  it('refuses whitespace, which renders identically to nothing', () => {
    for (const blank of [' ', '\t', '\n', '   \n  ']) {
      expect(() => explain(blank)).toThrow(EmptyExplanationError);
    }
  });

  it('returns the sentence unchanged, so the brand costs nothing at runtime', () => {
    expect(explain('It ran after the merge.')).toBe('It ran after the merge.');
  });

  it('says what is wrong, rather than throwing a bare type name', () => {
    // The message reaches a probe author through probeFile's catch, so it has
    // to be a sentence for the same reason a verdict does.
    expect(() => explain('')).toThrow(/never empty/);
  });

  it('agrees with isExplanation on every case', () => {
    for (const text of ['', ' ', '\n', 'a', 'It ran.']) {
      const accepted = isExplanation(text);
      let constructed = true;
      try {
        explain(text);
      } catch {
        constructed = false;
      }
      expect(constructed).toBe(accepted);
    }
  });

  it('rejects non-strings, which is what a JS caller can still hand it', () => {
    for (const value of [undefined, null, 0, {}, []]) {
      expect(isExplanation(value)).toBe(false);
    }
  });
});

function v(file: string, status: ExerciseVerdict['status']): ExerciseVerdict {
  const explanation = explain(`${file} is ${status}.`);
  return status === 'exercised' || status === 'not-exercised'
    ? { file, status, explanation, evidence: `the ${status} fixture` }
    : { file, status, explanation };
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
