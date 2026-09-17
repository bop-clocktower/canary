/**
 * Did ordering help? (#460 criterion 7, D7, F8.) Over the first 20 recorded
 * runs of a suite that had a failure, compare the median ordered
 * time-to-first-failure against the median baseline. Advisory only (F8a).
 *
 * The denominator is printed in full: runs recorded with a plan, how many of
 * them had a failure, how many did not. Fewer than 20 measurable runs is
 * `insufficient`, never an early verdict.
 */

import type { RunRecord } from '../../history/record.js';

export const TTFF_WINDOW = 20;

export interface TtffReport {
  suite: string;
  /** Runs recorded with an order plan. */
  ordered: number;
  measurable: number;
  notMeasurable: number;
  window: number;
  medianOrderedMs: number | null;
  medianBaselineMs: number | null;
  verdict: 'lower' | 'not-lower' | 'insufficient';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function ttffReport(runs: RunRecord[], suite: string): TtffReport {
  const ordered = runs
    .filter((r) => r.suite === suite && r.order !== undefined)
    .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const measurable = ordered.filter(
    (r) =>
      r.order!.ttff_ordered_ms_estimate !== null &&
      r.order!.ttff_baseline_ms_estimate !== null,
  );
  const window = measurable.slice(0, TTFF_WINDOW);
  const medianOrderedMs = median(
    window.map((r) => r.order!.ttff_ordered_ms_estimate!),
  );
  const medianBaselineMs = median(
    window.map((r) => r.order!.ttff_baseline_ms_estimate!),
  );
  let verdict: TtffReport['verdict'] = 'insufficient';
  if (window.length === TTFF_WINDOW) {
    verdict = medianOrderedMs! < medianBaselineMs! ? 'lower' : 'not-lower';
  }
  return {
    suite,
    ordered: ordered.length,
    measurable: measurable.length,
    notMeasurable: ordered.length - measurable.length,
    window: window.length,
    medianOrderedMs,
    medianBaselineMs,
    verdict,
  };
}
