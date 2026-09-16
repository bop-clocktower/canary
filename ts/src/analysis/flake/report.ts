/**
 * The fleet-wide flaky Markdown report (#604).
 *
 * Split out of `reports.ts` when Phase 2 added the cross-run flip axis: that
 * module was over its file-length and coupling budgets, and this section owns
 * every import the rest of it does not need. Pure: rows in, Markdown out.
 */

import {
  assessFlakyWindow,
  type FlakyWindow,
} from '../../util/flake-window.js';
import { maxFlakeOrFlipRate } from '../../util/alternation.js';
import { formatWithDecimalPoint, num1 } from '../../util/round.js';
import type { FlakyRow } from '../rows.js';
import { flipCountCell, flipRateCell } from './cells.js';

// Re-exported so `reports.ts` can type the digest's flake-window argument
// without a second edge to `util/flake-window` (coupling budget).
export type { FlakyWindow };

// ---------------------------------------------------------------------------
// Flaky report
// ---------------------------------------------------------------------------

/**
 * `win` is the window the rows were read over (#604); `null` is an UNKNOWN
 * window, which withholds the green all-clear rather than earning it.
 */
export function buildFlakyTestsReport(
  rows: FlakyRow[],
  windowRuns: number,
  minRatePct: number,
  win: FlakyWindow | null = null,
  limit = 20,
): string {
  const assessment = assessFlakyWindow(windowRuns, win);
  const preamble =
    [assessment.header, ...assessment.disclosures].join('\n') + '\n';
  if (rows.length === 0) {
    if (!assessment.clean) return preamble;
    return `${preamble}No tests above ${formatWithDecimalPoint(minRatePct)}% flake rate in the last ${windowRuns} runs.\n`;
  }

  // Decision D4: rank on max(flake, flip) so an alternator is not buried.
  const sorted = [...rows]
    .sort((a, b) => maxFlakeOrFlipRate(b) - maxFlakeOrFlipRate(a))
    .slice(0, limit);
  const lines = [
    `## Fleet-wide Flaky Tests (top ${limit}, window: ${windowRuns} runs, threshold: ≥ ${formatWithDecimalPoint(minRatePct)}%)\n`,
    '| Test | Suite | Area | Flake % | Flake/Total | Flip % | Flips/Observed |',
    '|------|-------|------|---------|-------------|--------|----------------|',
  ];
  for (const r of sorted) {
    lines.push(
      `| ${r.test_name} | ${r.suite ?? ''} | ${r.area || '—'} ` +
        `| ${num1(r.flake_rate_pct)}% | ${r.flake_count}/${r.total_runs} ` +
        `| ${flipRateCell(r)} | ${flipCountCell(r)} |`,
    );
  }
  return preamble + lines.join('\n') + '\n';
}
