/**
 * The `queryFlaky` row accumulator for the NDJSON store.
 *
 * Split out of `ndjson-store.ts` when #604 Phase 2 added the ordered status
 * sequence the flip axis is computed from: `history/`'s top-level module-size
 * budget had no room for it, which is the same reason `flake/render.ts` exists.
 * Pure -- no I/O, no store.
 */

import {
  alternationVerdict,
  detectAlternation,
} from '../../util/alternation.js';
import { def } from '../../util/coalesce.js';
import { round1 } from '../../util/round.js';
import type { RunRecord, TestResultRecord } from '../record.js';

export interface FlakyQueryRow {
  test_name: string;
  test_file: string;
  suite: string;
  area: string | null;
  flake_count: number;
  pass_count: number;
  fail_count: number;
  total_runs: number;
  last_seen_run: string | null;
  flake_rate_pct: number;
  /**
   * The cross-run flip axis (#604 Phase 2 / G1). OPTIONAL on purpose: a
   * backend that cannot hand back an ordered per-test sequence (the remote
   * Supabase store) leaves these ABSENT, which surfaces render as UNKNOWN.
   * An absent field is not a zero -- see `util/alternation.ts`.
   */
  flip_count?: number;
  flip_rate_pct?: number;
  /** Definitive (`passed`/`failed`) observations behind the flip fields. */
  observed?: number;
  /**
   * `true` alternating, `false` measured clean, `null` UNKNOWN because fewer
   * than `MIN_DEFINITIVE_OBSERVATIONS` outcomes were seen (Decision D5/H2).
   */
  alternating?: boolean | null;
}

/**
 * The accumulator behind one row. `statuses` is the ordered sequence #604
 * Phase 2 added: `applyStatus` keeps counts, and counts cannot see the ORDER
 * that a flip is defined by.
 */
export type FlakyCounter = Omit<
  FlakyQueryRow,
  'flake_rate_pct' | 'flip_count' | 'flip_rate_pct' | 'observed' | 'alternating'
> & { statuses: string[] };

export function newFlakyCounter(
  record: RunRecord,
  t: TestResultRecord,
): FlakyCounter {
  return {
    statuses: [],
    test_name: t.test_name,
    test_file: def(t.test_file, ''),
    suite: def(t.suite, def(record.suite, '')),
    area: def(t.area, null),
    flake_count: 0,
    pass_count: 0,
    fail_count: 0,
    total_runs: 0,
    last_seen_run: null,
  };
}

/** Finish one accumulator into a row, both axes measured. */
export function toFlakyRow(c: FlakyCounter, minRate: number): FlakyQueryRow {
  const { statuses, ...counts } = c;
  const alt = detectAlternation(statuses);
  return {
    ...counts,
    flake_rate_pct: round1((c.flake_count / c.total_runs) * 100),
    flip_count: alt.flip_count,
    flip_rate_pct: alt.flip_rate_pct,
    observed: alt.observed,
    alternating: alternationVerdict(alt, minRate),
  };
}

export function applyStatus(c: FlakyCounter, status: string): void {
  if (status === 'flaky') c.flake_count += 1;
  else if (status === 'passed') c.pass_count += 1;
  else if (status === 'failed') c.fail_count += 1;
}
