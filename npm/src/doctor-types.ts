'use strict';

/**
 * Doctor check result types, in a leaf module so the check producers
 * (`doctor-manifest.ts`, `engine-checks.ts`) can name them without importing
 * `doctor.ts`, which imports them back — a type-only import cycle that harness
 * 13's arch gate counts (`circular-deps`). `doctor.ts` re-exports both.
 */

/** Outcome of a single doctor check. */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'info';

/** A single doctor check result, rendered as one output line. */
export interface CheckResult {
  /** Stable identifier (engine check id, or the manifest check's `id`). */
  id: string;
  status: CheckStatus;
  /** Human-readable label for the check line. */
  label: string;
  /** Shown indented under the line when the check does not pass. */
  remedy?: string;
}
