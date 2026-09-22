import { describe, expect, it } from 'vitest';

import { detectRegressions } from './detector.js';
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
