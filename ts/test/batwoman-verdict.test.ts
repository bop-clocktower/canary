/**
 * The verdict model's one structural invariant: `abstain` and `no-probe` are
 * separate values. Collapsing them would hide whether a file suffers a probe
 * that could not decide or a registry with no probe at all (spec D3).
 */
import { describe, expect, it } from 'vitest';

import { EXERCISE_STATUSES } from '../src/analysis/batwoman/verdict.js';

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
