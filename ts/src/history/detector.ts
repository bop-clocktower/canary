/**
 * Regression detection on top of history query results.
 *
 * Pure functions — no I/O.
 * Input is the timeline output from the history store.
 */

import type { TimelineEntry } from './record.js';

export interface RegressionResult {
  is_regression: boolean;
  green_streak: number;
  first_failure_commit: string | null;
}

const BAD_STATUSES = new Set(['failed', 'flaky']);

/**
 * Detect whether a test regressed: green for `minGreen` runs, then failing for
 * the last `recentFailures` runs.
 */
export function detectRegressions(
  timeline: TimelineEntry[],
  minGreen = 5,
  recentFailures = 3,
): RegressionResult {
  const none: RegressionResult = {
    is_regression: false,
    green_streak: 0,
    first_failure_commit: null,
  };

  if (timeline.length === 0) return none;

  const tail =
    timeline.length >= recentFailures ? timeline.slice(-recentFailures) : [];
  if (tail.length < recentFailures) return none;

  if (!tail.every((r) => BAD_STATUSES.has(r.status))) return none;

  const firstFailIdx = timeline.length - recentFailures;
  let streak = 0;
  for (let i = firstFailIdx - 1; i >= 0; i--) {
    if (timeline[i]!.status === 'passed') streak++;
    else break;
  }

  if (streak < minGreen) {
    return {
      is_regression: false,
      green_streak: streak,
      first_failure_commit: null,
    };
  }

  return {
    is_regression: true,
    green_streak: streak,
    first_failure_commit: timeline[firstFailIdx]!.commit_sha ?? null,
  };
}
