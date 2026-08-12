/**
 * The SC-3 fidelity ladder itself, plus the record of what the coverage input
 * actually was on this run (#554) — the denominator that separates "checked and
 * clean" from "never checked".
 */

import { resolveFromGraph } from './graph-tier.js';
import { resolveHeuristic } from './heuristic-tier.js';
import { matchUnitsToIndex, readReportIndex } from './report-tier.js';
import type { ChangedUnit, CoverageResult } from './types.js';

/** Options for {@link resolveCoverage}. */
export interface ResolveCoverageOptions {
  coveragePath?: string | null;
  graphPath?: string;
  repoRoot?: string;
  graphMaxDepth?: number | null;
}

/**
 * SC-3 orchestrator: resolve each unit at the highest available fidelity.
 *
 * The ladder is applied **per unit**, not per batch. For each unit the first
 * tier that has a signal for *that* unit wins:
 *
 *   1. `coveragePath` lists the unit's path → `COVERAGE_VERIFIED`
 *   2. else a graph node for the unit exists → `GRAPH_VERIFIED`
 *   3. else the naming heuristic             → `HEURISTIC` (always returns)
 *
 * A unit absent from the report is NOT judged COVERAGE_VERIFIED-uncovered; it
 * falls through to the graph then heuristic tier (FIX 2). Returns exactly one
 * {@link CoverageResult} per input unit, in input order, fidelity-labeled.
 *
 * `graphMaxDepth` bounds the graph tier's reverse-BFS hop distance (#320) and
 * is forwarded verbatim to `resolveFromGraph`.
 */
export function resolveCoverage(
  units: ChangedUnit[],
  options: ResolveCoverageOptions = {},
): CoverageResult[] {
  return resolveCoverageWithInput(units, options).results;
}

/**
 * The coverage input's actual state for one run (#554).
 *
 * Every field is a count or a fact about what the run *observed*, never a
 * verdict. `unitsMatched` of `unitsTotal` is the load-bearing pair: it is the
 * denominator that tells a later reader whether "no coverage findings" meant
 * "checked and clean" or "never checked".
 */
export interface CoverageInputState {
  /** The `--coverage` path as given, or `null` when none was supplied. */
  requested: string | null;
  /** A file exists at `requested`. */
  found: boolean;
  /** That file parsed into at least one usable record. */
  parsed: boolean;
  /** How many files the parsed report carries coverage for. */
  filesInReport: number;
  /** Changed units the report actually spoke to (coverage-verified). */
  unitsMatched: number;
  /** Changed units submitted to the ladder. */
  unitsTotal: number;
}

/**
 * `verified` (the report spoke to every changed unit) | `partial` (some) |
 * `unavailable` (none — whatever the reason).
 */
export type CoverageStatus = 'verified' | 'partial' | 'unavailable';

/** Classify a {@link CoverageInputState}. Zero matched is never `verified`. */
export function coverageStatus(state: CoverageInputState): CoverageStatus {
  if (state.unitsTotal > 0 && state.unitsMatched === state.unitsTotal) {
    return 'verified';
  }
  return state.unitsMatched > 0 ? 'partial' : 'unavailable';
}

const COVERAGE_EM_DASH = '\u{2014}';
const FALLBACK_TIER = 'judged at graph/heuristic tier only';

/**
 * The human-readable degradation notice for a coverage run, or `null` when the
 * report covered every changed unit (nothing was degraded, so nothing is said).
 *
 * A run that judged nothing (`unitsTotal === 0`) also returns `null` — it makes
 * no coverage claim in either direction, and the abstention path reports it.
 */
export function coverageDegradedNotice(
  state: CoverageInputState,
): string | null {
  const { requested, found, parsed, filesInReport } = state;
  const { unitsMatched: matched, unitsTotal: total } = state;
  if (total === 0) return null;
  const status = coverageStatus(state);
  if (status === 'verified') return null;
  const dash = ` ${COVERAGE_EM_DASH} `;

  if (status === 'partial') {
    return (
      `coverage partial${dash}report at '${requested}' matched ` +
      `${matched} of ${total} changed file(s); the other ${total - matched} ` +
      FALLBACK_TIER
    );
  }
  const head = `coverage unavailable${dash}`;
  if (requested === null) {
    return `${head}no coverage report was supplied; ${total} changed file(s) ${FALLBACK_TIER}`;
  }
  if (!found) {
    return `${head}report not found at '${requested}'; ${total} changed file(s) ${FALLBACK_TIER}`;
  }
  if (!parsed) {
    return (
      `${head}report at '${requested}' yielded no usable records; ` +
      `${total} changed file(s) ${FALLBACK_TIER}`
    );
  }
  return (
    `${head}report at '${requested}' covers ${filesInReport} file(s) but ` +
    `matched 0 of ${total} changed file(s); ${FALLBACK_TIER}`
  );
}

/** {@link resolveCoverage}'s results plus the run's {@link CoverageInputState}. */
export interface ResolvedCoverage {
  results: CoverageResult[];
  coverage: CoverageInputState;
}

/**
 * {@link resolveCoverage}, additionally reporting which mode the run was in.
 *
 * Identical ladder, identical results — the only addition is the
 * {@link CoverageInputState} record, so a later reader can tell a clean result
 * from a blind one (#554).
 */
export function resolveCoverageWithInput(
  units: ChangedUnit[],
  options: ResolveCoverageOptions = {},
): ResolvedCoverage {
  const {
    coveragePath = null,
    graphPath = '.harness/graph/graph.json',
    repoRoot = '.',
    graphMaxDepth = null,
  } = options;

  // Reference-keyed map mirrors the Python `id(unit)` bookkeeping, so distinct
  // units that happen to share a path are still tracked independently.
  const resolved = new Map<ChangedUnit, CoverageResult>();
  let remaining: ChangedUnit[] = [...units];
  const coverage: CoverageInputState = {
    requested: coveragePath,
    found: false,
    parsed: false,
    filesInReport: 0,
    unitsMatched: 0,
    unitsTotal: units.length,
  };

  if (coveragePath !== null) {
    const read = readReportIndex(coveragePath);
    coverage.found = read.found;
    coverage.parsed = read.index !== null;
    coverage.filesInReport =
      read.index === null ? 0 : Object.keys(read.index).length;
    const report =
      read.index === null ? null : matchUnitsToIndex(remaining, read.index);
    // An empty array (no unit matched the report) is falsy-equivalent in the
    // Python `if report:` guard — fall through rather than lock in nothing.
    if (report !== null && report.length > 0) {
      for (const r of report) resolved.set(r.unit, r);
      coverage.unitsMatched = report.length;
      remaining = remaining.filter((u) => !resolved.has(u));
    }
  }

  if (remaining.length > 0) {
    const graph = resolveFromGraph(remaining, graphPath, graphMaxDepth);
    if (graph !== null && graph.length > 0) {
      for (const r of graph) resolved.set(r.unit, r);
      remaining = remaining.filter((u) => !resolved.has(u));
    }
  }

  if (remaining.length > 0) {
    for (const r of resolveHeuristic(remaining, repoRoot)) {
      resolved.set(r.unit, r);
    }
  }

  return { results: units.map((unit) => resolved.get(unit)!), coverage };
}
