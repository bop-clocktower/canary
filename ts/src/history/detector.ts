/**
 * Flakiness and regression detection on top of history query results.
 *
 * Faithful TS port of `agent/history/detector.py`. Pure functions — no I/O.
 * Input is the timeline output from the history store.
 */

import type { TimelineEntry } from './record.js';

export enum FlakeTrend {
  Rising = 'rising',
  Falling = 'falling',
  Stable = 'stable',
}

const TREND_THRESHOLD = 0.1;

/** Classify a time-ordered list of per-run flake rates (0.0–1.0). */
export function classifyFlakeTrend(rates: number[]): FlakeTrend {
  if (rates.length < 2) return FlakeTrend.Stable;

  const mid = Math.floor(rates.length / 2);
  const firstHalf = rates.slice(0, mid);
  const secondHalf = rates.slice(mid);

  const mean = (xs: number[]): number =>
    xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = mean(secondHalf) - mean(firstHalf);

  if (delta >= TREND_THRESHOLD) return FlakeTrend.Rising;
  if (delta <= -TREND_THRESHOLD) return FlakeTrend.Falling;
  return FlakeTrend.Stable;
}

/**
 * Cross-run pass/fail alternation for one test (#604).
 *
 * The flake rate counts the `flaky` status — a within-run retry that passed.
 * `canary history record` never writes that status (vitest has no such
 * outcome), so a test that goes green, red, green, red ACROSS runs arrived with
 * `flake_count: 0` and was invisible to every flake surface. This measures the
 * other axis: how often consecutive definitive outcomes disagree.
 *
 * Only `passed` and `failed` are observations. `flaky` is already the flake
 * rate's subject and `skipped` is not an outcome; counting either as a side
 * would manufacture flips (p, skip, p is not a change) or hide them.
 */
export interface AlternationResult {
  /** Transitions between consecutive definitive outcomes that disagreed. */
  flip_count: number;
  /** Definitive (`passed` / `failed`) observations in the sequence. */
  observed: number;
  /** `flip_count / (observed - 1)` on a 0–100 scale, 0 below two observations. */
  flip_rate_pct: number;
}

/**
 * Flips below which a test is not alternating, whatever its rate. One flip is
 * a step change — a regression or a fix — and `detectRegressions` owns that
 * shape; only a test that changed AND changed back is oscillating. Without
 * this floor a two-run history reading `passed, failed` is a 100% alternator,
 * and every fresh regression would be reported as a flake to retry.
 */
export const MIN_ALTERNATION_FLIPS = 2;

const DEFINITIVE = new Set(['passed', 'failed']);

/** Count passed<->failed transitions in a time-ordered status sequence. */
export function detectAlternation(
  statuses: readonly string[],
): AlternationResult {
  const outcomes = statuses.filter((s) => DEFINITIVE.has(s));
  let flips = 0;
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] !== outcomes[i - 1]) flips++;
  }
  const transitions = outcomes.length - 1;
  return {
    flip_count: flips,
    observed: outcomes.length,
    flip_rate_pct: transitions > 0 ? round1((flips / transitions) * 100) : 0,
  };
}

/**
 * Whether a row alternates: at least {@link MIN_ALTERNATION_FLIPS} flips AND a
 * flip rate at or above `minRatePct`. A row whose backend never measured
 * flips (the fields are optional on the Supabase read path) is `false` — not
 * because it is clean, but because UNKNOWN cannot be rendered as a finding.
 * Callers that show a clean result over such rows must say so.
 */
export function isAlternating(
  row: { flip_count?: number; flip_rate_pct?: number },
  minRatePct: number,
): boolean {
  return (
    (row.flip_count ?? 0) >= MIN_ALTERNATION_FLIPS &&
    (row.flip_rate_pct ?? 0) >= minRatePct
  );
}

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
