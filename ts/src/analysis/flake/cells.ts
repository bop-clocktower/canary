/**
 * Flip-axis Markdown cells for the fleet-wide flaky report (#604 Phase 2).
 *
 * Split out of `reports.ts` for `analysis/`'s top-level module-size budget,
 * mirroring `history/flake/`. Pure formatting.
 */

import { num1 } from '../../util/round.js';
import type { FlakyRow } from '../rows.js';

/**
 * The flip axis renders UNKNOWN, never 0, on a backend that does not measure
 * it (#604 Phase 2, G4) -- an absent measurement read as a zero is the false
 * green this spec exists to remove.
 */
export function flipRateCell(r: FlakyRow): string {
  return r.flip_rate_pct === undefined
    ? 'UNKNOWN'
    : `${num1(r.flip_rate_pct)}%`;
}

export function flipCountCell(r: FlakyRow): string {
  return r.flip_count === undefined
    ? 'UNKNOWN'
    : `${r.flip_count}/${r.observed ?? 0}`;
}
