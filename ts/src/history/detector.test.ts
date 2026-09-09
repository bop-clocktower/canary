import { describe, expect, it } from 'vitest';

import {
  classifyFlakeTrend,
  detectAlternation,
  detectRegressions,
  FlakeTrend,
  isAlternating,
  MIN_ALTERNATION_FLIPS,
} from './detector.js';
import type { TimelineEntry } from './record.js';

function entry(status: string, commit = ''): TimelineEntry {
  return {
    run_id: 'r',
    suite: 'api',
    branch: 'main',
    commit_sha: commit,
    timestamp: '2026-06-01T00:00:00Z',
    status,
    failure_category: null,
    error_text: null,
    retry_count: 0,
  };
}

describe('classifyFlakeTrend', () => {
  it('is stable with fewer than two points', () => {
    expect(classifyFlakeTrend([0.5])).toBe(FlakeTrend.Stable);
  });
  it('detects rising and falling trends', () => {
    expect(classifyFlakeTrend([0.0, 0.0, 0.5, 0.6])).toBe(FlakeTrend.Rising);
    expect(classifyFlakeTrend([0.6, 0.5, 0.0, 0.0])).toBe(FlakeTrend.Falling);
  });
  it('is stable within the threshold', () => {
    expect(classifyFlakeTrend([0.2, 0.2, 0.22, 0.21])).toBe(FlakeTrend.Stable);
  });
});

describe('detectAlternation (#604)', () => {
  it('reports zero flips over fewer than two definitive observations', () => {
    expect(detectAlternation([])).toEqual({
      flip_count: 0,
      observed: 0,
      flip_rate_pct: 0,
    });
    expect(detectAlternation(['passed'])).toEqual({
      flip_count: 0,
      observed: 1,
      flip_rate_pct: 0,
    });
  });

  it('counts every passed<->failed transition between consecutive runs', () => {
    // p f p f p f p p -> 6 flips across 7 transitions
    const r = detectAlternation([
      'passed',
      'failed',
      'passed',
      'failed',
      'passed',
      'failed',
      'passed',
      'passed',
    ]);
    expect(r.flip_count).toBe(6);
    expect(r.observed).toBe(8);
    expect(r.flip_rate_pct).toBe(85.7);
  });

  it('sees a regression as ONE flip, which is a step change, not alternation', () => {
    const r = detectAlternation([
      'passed',
      'passed',
      'passed',
      'failed',
      'failed',
      'failed',
    ]);
    expect(r.flip_count).toBe(1);
    expect(isAlternating({ ...r }, 10)).toBe(false);
  });

  it('ignores skipped and flaky observations rather than counting them as a side', () => {
    // A within-run retry-pass (`flaky`) is already the flake rate's subject;
    // a skip is not an outcome. Neither may manufacture or hide a flip.
    const r = detectAlternation([
      'passed',
      'flaky',
      'skipped',
      'passed',
      'failed',
      'passed',
    ]);
    expect(r.observed).toBe(4);
    expect(r.flip_count).toBe(2);
    expect(r.flip_rate_pct).toBe(66.7);
  });

  it('isAlternating needs both the flip floor and the rate threshold', () => {
    expect(MIN_ALTERNATION_FLIPS).toBe(2);
    expect(isAlternating({ flip_count: 2, flip_rate_pct: 20 }, 10)).toBe(true);
    expect(isAlternating({ flip_count: 2, flip_rate_pct: 5 }, 10)).toBe(false);
    expect(isAlternating({ flip_count: 1, flip_rate_pct: 100 }, 10)).toBe(
      false,
    );
  });

  it('isAlternating is false, never true, when the backend did not measure', () => {
    // Supabase rows carry no flip fields (#604): unknown is not alternating,
    // but it is not clean either -- the caller names that as a caveat.
    expect(isAlternating({}, 10)).toBe(false);
  });
});

describe('detectRegressions', () => {
  it('returns not-regression on an empty timeline', () => {
    expect(detectRegressions([])).toEqual({
      is_regression: false,
      green_streak: 0,
      first_failure_commit: null,
    });
  });

  it('needs at least recentFailures runs', () => {
    const t = [entry('passed'), entry('failed')];
    expect(detectRegressions(t, 1, 3).is_regression).toBe(false);
  });

  it('requires the tail to be all bad', () => {
    const t = [
      entry('passed'),
      entry('passed'),
      entry('passed'),
      entry('passed'),
      entry('passed'),
      entry('failed'),
      entry('passed'),
      entry('failed'),
    ];
    expect(detectRegressions(t, 5, 3).is_regression).toBe(false);
  });

  it('flags a regression after a long green streak', () => {
    const t = [
      ...Array.from({ length: 6 }, () => entry('passed')),
      entry('failed', 'deadbeef'),
      entry('failed'),
      entry('flaky'),
    ];
    const r = detectRegressions(t, 5, 3);
    expect(r.is_regression).toBe(true);
    expect(r.green_streak).toBe(6);
    expect(r.first_failure_commit).toBe('deadbeef');
  });

  it('does not flag when the green streak is too short', () => {
    const t = [
      entry('failed'),
      entry('passed'),
      entry('passed'),
      entry('failed'),
      entry('failed'),
      entry('failed'),
    ];
    const r = detectRegressions(t, 5, 3);
    expect(r.is_regression).toBe(false);
    expect(r.green_streak).toBe(2);
  });
});
