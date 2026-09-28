/**
 * Per-consumer field coverage over a history store (#610). Pure.
 *
 * A history consumer is only as live as the least-populated field it reads, so
 * each consumer's status is derived from the coverage of its requirements. The
 * denominator rule (#508) applies per requirement: a requirement with no
 * applicable rows is UNMEASURED, never fed -- "0 of 0 failed tests carry a
 * category" says nothing about whether the writer fills it.
 */
import type { RunRecord, TestResultRecord } from '../../history/record.js';
import { CONSUMERS } from './consumers.js';
import type { Consumer, Requirement, Scope } from './consumers.js';

export interface RequirementCoverage {
  field: string;
  scope: Scope;
  carried: number;
  applicable: number;
}

export type ConsumerStatus = 'fed' | 'partial' | 'dark' | 'unmeasured';

export interface ConsumerGap {
  id: string;
  surface: string;
  status: ConsumerStatus;
  optIn?: string;
  coverage: RequirementCoverage[];
}

export interface GapReport {
  runs: number;
  tests: number;
  consumers: ConsumerGap[];
}

// The rows a failure_category means anything on; mirrors the analyze engine's
// failure predicate (`isFailureWithError`, analysis/engine.ts).
const FAILED = new Set(['failed', 'flaky']);

function applies(scope: Scope, test: TestResultRecord): boolean {
  return scope === 'test' || FAILED.has(test.status);
}

function measure(
  req: Requirement,
  records: readonly RunRecord[],
): RequirementCoverage {
  let carried = 0;
  let applicable = 0;
  for (const run of records) {
    if (req.scope === 'run') {
      applicable += 1;
      if (req.carried(run)) carried += 1;
      continue;
    }
    for (const test of run.tests ?? []) {
      if (!applies(req.scope, test)) continue;
      applicable += 1;
      if (req.carried(run, test)) carried += 1;
    }
  }
  return { field: req.field, scope: req.scope, carried, applicable };
}

/** Unmeasured outranks everything: no denominator is never a pass. */
function statusOf(cov: readonly RequirementCoverage[]): ConsumerStatus {
  if (cov.some((c) => c.applicable === 0)) return 'unmeasured';
  if (cov.every((c) => c.carried === c.applicable)) return 'fed';
  if (cov.some((c) => c.carried === 0)) return 'dark';
  return 'partial';
}

function gapFor(c: Consumer, records: readonly RunRecord[]): ConsumerGap {
  const coverage = c.requirements.map((r) => measure(r, records));
  const gap: ConsumerGap = {
    id: c.id,
    surface: c.surface,
    status: statusOf(coverage),
    coverage,
  };
  if (c.optIn !== undefined) gap.optIn = c.optIn;
  return gap;
}

/** Coverage of every consumer's requirements over `records`. */
export function analyzeGaps(
  records: readonly RunRecord[],
  consumers: readonly Consumer[] = CONSUMERS,
): GapReport {
  const tests = records.reduce((n, r) => n + (r.tests?.length ?? 0), 0);
  return {
    runs: records.length,
    tests,
    consumers: consumers.map((c) => gapFor(c, records)),
  };
}
