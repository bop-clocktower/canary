/**
 * Human rendering for `canary history` — the aligned text table shared by
 * `flaky`, `timeline` and `summary`, plus the `flaky` report itself.
 *
 * Extracted from `cli.ts` when #604 gave `flaky` a window-disclosure preamble:
 * the command handler had grown past the complexity and function-length
 * thresholds, and `history/`'s top-level module-size budget had no room for
 * it. Rendering is pure (it returns lines rather than writing them), so the
 * whole report is assertable without a CLI or a sink.
 */

import pc from 'picocolors';

import { formatWithDecimalPoint } from '../../util/round.js';
import type { FlakyQueryRow } from '../ndjson-store.js';
import {
  assessFlakyWindow,
  type FlakyWindow,
} from '../../util/flake-window.js';
import { maxFlakeOrFlipRate } from '../../util/alternation.js';

const GEQ = '\u{2265}';
const MDASH_CELL = '\u{2014}'; // rich `r.get("area") or <em-dash>`
/**
 * An unmeasured cell (#604 Phase 2, G4). A count-only backend has no flip
 * data, and rendering that as `0.0%` would be the exact false green Phase 1
 * removed from the window line -- so it says so instead.
 */
const UNKNOWN_CELL = 'UNKNOWN';

/** The flip cells: measured numbers, or UNKNOWN when the axis is absent. */
function flipCells(r: FlakyQueryRow): [string, string] {
  if (r.flip_rate_pct === undefined || r.flip_count === undefined) {
    return [UNKNOWN_CELL, UNKNOWN_CELL];
  }
  return [
    `${formatWithDecimalPoint(r.flip_rate_pct)}%`,
    `${r.flip_count}/${r.observed ?? 0}`,
  ];
}

/**
 * A minimal aligned text table — the documented `rich.Table` deviation (see
 * the port notes in `cli.ts`): same cell content, simpler box bytes.
 */
export function renderTable(
  title: string,
  headers: string[],
  rows: string[][],
  rightAlign: boolean[],
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const pad = (cell: string, i: number): string =>
    rightAlign[i] ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!);
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => pad(c, i)).join('  ');
  const lines = [title, fmt(headers)];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  return lines;
}

function flakyTableRow(r: FlakyQueryRow): string[] {
  return [
    r.test_name,
    r.suite ?? '',
    r.area || MDASH_CELL,
    // formatWithDecimalPoint so a whole-number rate renders `10.0%` like
    // Python str(float), not `10%` (JS number has no int/float distinction).
    `${formatWithDecimalPoint(r.flake_rate_pct)}%`,
    `${r.flake_count}/${r.total_runs}`,
    ...flipCells(r),
  ];
}

/**
 * The `history flaky` human report (#604).
 *
 * The window comes FIRST (SC3), so a reader cannot take in a verdict without
 * its denominator, and the green all-clear is printed ONLY over a window that
 * is both known and at the minimum size (SC2/SC5) — the false green this
 * command shipped with was a green line earned by two runs.
 */
export function renderFlakyReport(
  rows: FlakyQueryRow[],
  window: number,
  minRate: number,
  win: FlakyWindow | null,
): string[] {
  const assessment = assessFlakyWindow(window, win);
  const lines = [assessment.header];
  for (const note of assessment.disclosures) lines.push(pc.yellow(note));

  if (rows.length === 0) {
    if (assessment.clean) {
      lines.push(
        pc.green(
          `No tests above ${formatWithDecimalPoint(minRate)}% flake rate in the last ${window} runs.`,
        ),
      );
    }
    return lines;
  }

  return lines.concat(
    renderTable(
      `Flaky Tests (window: ${window} runs, threshold: ${GEQ} ${formatWithDecimalPoint(minRate)}%)`,
      [
        'Test',
        'Suite',
        'Area',
        'Flake %',
        'Flake/Total',
        'Flip %',
        'Flips/Observed',
      ],
      [...rows]
        .sort((a, b) => maxFlakeOrFlipRate(b) - maxFlakeOrFlipRate(a))
        .map(flakyTableRow),
      [false, false, false, true, true, true, true],
    ),
  );
}
