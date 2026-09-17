/**
 * The schema v3 `replay` block on a stored run (#461, ADR 0030).
 *
 * Kept in its own leaf file, with no imports, so `record.ts` and `schema.ts`
 * can name it without widening the top-level history module.
 */

/**
 * What a later replay needs and the report alone cannot say (#461, schema v3).
 *
 * Every field is nullable and `null` means UNKNOWN, never zero or default: a
 * replay lists an unknown dimension as `not-recorded` rather than guessing it.
 * Only the names below are read from the environment, so no variable VALUE a
 * secret could live in reaches the store.
 */
export interface ReplayContext {
  seed: string | null;
  /** `report` is reserved: no supported reader carries a seed today. */
  seed_source: 'flag' | 'report' | null;
  runner: { name: string; version: string | null };
  node: string;
  os: string;
  arch: string;
  ci: 'github-actions' | 'other' | null;
  /** `null` for a `local` commit, which makes the run non-replayable. */
  commit_source: 'flag' | 'GITHUB_SHA' | 'HEAD' | null;
}

/**
 * `record --order-plan` estimates (#460 D7), local-only. Serial sums of
 * recorded durations; null when the run had no failure (not measurable).
 */
export interface OrderOutcome {
  mode: string | null;
  ttff_ordered_ms_estimate: number | null;
  ttff_baseline_ms_estimate: number | null;
}
