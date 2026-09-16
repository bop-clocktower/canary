/**
 * Cross-run pass/fail alternation -- the flake axis a flake RATE cannot see
 * (#604 Phase 2, gap G1, decisions D2-D5).
 *
 * `flake_count` only ever increments on the within-run `flaky` status: failed,
 * then passed on a retry. The vitest reader never writes that status
 * (`history/formats/vitest-report.ts`), so a test that goes passed, failed,
 * passed, failed ACROSS runs arrived with `flake_count: 0` and was invisible
 * to every flake surface. That population is exactly the one #604 was filed
 * for. This module measures the other axis: how often consecutive definitive
 * outcomes disagree.
 *
 * Only `passed` and `failed` are observations. `flaky` is already the flake
 * rate's subject, and `skipped` is not an outcome; counting either as a side
 * would manufacture flips (`passed, skipped, passed` is not a change) or hide
 * real ones.
 *
 * WHY `util/`: the same layering that put `flake-window.ts` here. The flip
 * computation has two consumers in different layers -- `core/ci-ready.ts`
 * scores the check, `history/` and `analysis/` render the reports -- and
 * `core -> history` is a layer violation `harness check-deps` rejects. Both
 * may depend on this leaf, which is also what stops the check and the
 * commands from disagreeing about what counts as a flip. Pure: no I/O.
 *
 * Provenance: `detectAlternation`, `isAlternating` and
 * {@link MIN_ALTERNATION_FLIPS} are ported from the abandoned WIP commit
 * `df06d3a` (branch `feat/604-cross-run-alternation`, red, never opened as a
 * PR), where they lived in `history/detector.ts` with unit tests. Moved here
 * for the layer reason above; {@link MIN_DEFINITIVE_OBSERVATIONS},
 * {@link alternationVerdict} and {@link maxFlakeOrFlipRate} are new.
 */

import { round1 } from './round.js';

/** What one test's cross-run sequence says about alternation. */
export interface AlternationResult {
  /** Transitions between consecutive definitive outcomes that disagreed. */
  flip_count: number;
  /** Definitive (`passed` / `failed`) observations in the sequence. */
  observed: number;
  /** `flip_count / (observed - 1)` on a 0-100 scale; 0 below two outcomes. */
  flip_rate_pct: number;
}

/**
 * Flips below which a test is not alternating, whatever its rate. One flip is
 * a step change -- a regression or a fix -- and `detectRegressions` owns that
 * shape; only a test that changed AND changed back is oscillating. Without
 * this floor a two-run history reading `passed, failed` is a 100% alternator,
 * and every fresh regression would be reported as a flake to retry.
 */
export const MIN_ALTERNATION_FLIPS = 2;

/**
 * Definitive observations a test needs before it may be reported as NOT
 * alternating (Decision D5/H2, signed off 2026-09-15). Below it a two-flip
 * pattern cannot be told apart from noise, so the verdict is UNKNOWN rather
 * than a clean `false` -- the same distinction Phase 1 draws between an
 * UNKNOWN window and a zero one. An assumption, not a derivation.
 *
 * Deliberately one-sided: it gates the CLEAN verdict only. A test that has
 * already been seen to change and change back was observed doing it, and
 * withholding that finding for want of a bigger sample would be its own false
 * green.
 */
export const MIN_DEFINITIVE_OBSERVATIONS = 8;

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

/** The flip fields a row may or may not carry, depending on its backend. */
export interface FlipFields {
  flip_count?: number;
  flip_rate_pct?: number;
  observed?: number;
}

/**
 * Whether a row alternates: at least {@link MIN_ALTERNATION_FLIPS} flips AND a
 * flip rate at or above `minRatePct`. A row whose backend never measured
 * flips is `false` -- not because it is clean, but because UNKNOWN cannot be
 * rendered as a finding. Callers showing a clean result over such rows must
 * say so, which is what {@link alternationVerdict}'s `null` is for.
 */
export function isAlternating(row: FlipFields, minRatePct: number): boolean {
  return (
    (row.flip_count ?? 0) >= MIN_ALTERNATION_FLIPS &&
    (row.flip_rate_pct ?? 0) >= minRatePct
  );
}

/**
 * The three-valued verdict a surface renders: `true` alternating, `false`
 * measured clean, `null` UNKNOWN because the sample is too thin to call
 * (fewer than {@link MIN_DEFINITIVE_OBSERVATIONS} observations).
 */
export function alternationVerdict(
  row: FlipFields,
  minRatePct: number,
): boolean | null {
  if (isAlternating(row, minRatePct)) return true;
  return (row.observed ?? 0) >= MIN_DEFINITIVE_OBSERVATIONS ? false : null;
}

/**
 * The ranking key: whichever axis is worse (Decision D4). Without it an
 * alternator at 60% flips sorts below a retry-flake at 20%, which is how the
 * WIP branch's checkpoint note described the bug.
 *
 * An absent flip axis counts as 0 for ORDERING only -- it must never be
 * rendered as a measured zero.
 */
export function maxFlakeOrFlipRate(
  row: FlipFields & { flake_rate_pct: number },
): number {
  return Math.max(row.flake_rate_pct, row.flip_rate_pct ?? 0);
}
