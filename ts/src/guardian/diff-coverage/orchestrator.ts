/**
 * The SC-3 fidelity ladder itself, plus the record of what the coverage input
 * actually was on this run (#554) — the denominator that separates "checked and
 * clean" from "never checked".
 */

import { resolveFromGraph } from './graph-tier.js';
import { resolveFromHeuristic } from './heuristic-tier.js';
import {
  countEligible,
  instrumentedTrees,
  matchUnitsToIndex,
  readReportIndex,
  zeroMatchClause,
} from './report-tier.js';
import type { ChangedUnit, CoverageResult } from './types.js';

/** Options for {@link resolveCoverage}. */
export interface ResolveCoverageOptions {
  coveragePath?: string | null;
  graphPath?: string;
  repoRoot?: string;
  graphMaxDepth?: number | null;
}

/**
 * SC-3 orchestrator, applied per unit: the report (`COVERAGE_VERIFIED`), else
 * the graph (`GRAPH_VERIFIED`, bounded by `graphMaxDepth`, #320), else the
 * naming heuristic. An absent unit falls through, never uncovered (FIX 2).
 * Returns one {@link CoverageResult} per unit, in input order.
 */
export function resolveCoverage(
  units: ChangedUnit[],
  options: ResolveCoverageOptions = {},
): CoverageResult[] {
  return resolveCoverageWithInput(units, options).results;
}

/**
 * What the coverage input actually was on one run (#554): observed counts and
 * facts, never a verdict. `unitsMatched` of `unitsTotal` separates "checked and
 * clean" from "never checked".
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
  /**
   * Units ABSENT from the parsed report that lie inside a tree it instruments
   * (#883, #928): the stale count. Absent when no report parsed.
   */
  unitsEligible?: number;
  /** Units the report lists whose changed lines are all non-coverable (#928). */
  unitsNonCoverable?: number;
  /** The repo-relative trees the parsed report instruments (#928). */
  instrumentedTrees?: string[];
}

/** The units the report did not verify, split by cause (#928). */
export function coverageCauses(state: CoverageInputState) {
  const nonCoverable = state.unitsNonCoverable ?? 0;
  const stale = state.unitsEligible ?? 0;
  const absent = state.unitsTotal - state.unitsMatched - nonCoverable;
  return { stale, scopeGap: absent - stale, nonCoverable };
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
  const { stale, scopeGap } = coverageCauses(state);
  // The report spoke to every unit, even if only to say "nothing coverable".
  if (parsed && stale + scopeGap === 0) return null;
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
    `${zeroMatchClause(state.unitsEligible, stale + scopeGap)}; ${FALLBACK_TIER}`
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
    if (read.index !== null) {
      const nonCoverable: ChangedUnit[] = [];
      const report = matchUnitsToIndex(remaining, read.index, nonCoverable);
      for (const r of report) resolved.set(r.unit, r);
      coverage.unitsMatched = report.length;
      coverage.unitsNonCoverable = nonCoverable.length;
      remaining = remaining.filter((u) => !resolved.has(u));
      // #928: only ABSENT units can make a report stale.
      const absent = remaining.filter((u) => !nonCoverable.includes(u));
      coverage.unitsEligible = countEligible(
        absent.map((u) => u.path),
        read.index,
        coveragePath,
        repoRoot,
      );
      coverage.instrumentedTrees = instrumentedTrees(
        read.index,
        coveragePath,
        repoRoot,
      );
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
    for (const r of resolveFromHeuristic(remaining, repoRoot)) {
      resolved.set(r.unit, r);
    }
  }

  return { results: units.map((unit) => resolved.get(unit)!), coverage };
}
