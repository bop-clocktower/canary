/**
 * Coverage **regression** on units a PR touches, versus base (#606).
 *
 * The fidelity ladder in `orchestrator.ts` answers one question — *is this
 * changed unit covered at all?* — and is blind to the case that actually ships
 * regressions: a file that was 95% covered on `main` and is 60% covered on the
 * PR head. Every line is still "covered", so the ladder reports nothing. This
 * module asks the second question by comparing two coverage reports over the
 * same touched files.
 *
 * It is a leaf of the diff-coverage package: it reads report indexes through
 * `report-tier.js` and speaks only in the shapes `types.js` defines. Finding
 * construction and severity live in `pr-check.ts`, which owns
 * `GuardianFinding` — nothing here imports upward.
 *
 * **Why a ratio and not line identity.** A diff shifts line numbers, so base
 * line N and head line N are not the same line. A per-line "was hit, now
 * unhit" rule would manufacture findings out of an insertion. The trigger is
 * therefore the whole-file covered ratio; the raw counts travel alongside it so
 * a reviewer can see the shape of the drop rather than a bare percentage.
 *
 * **Why the state object.** Most CI never uploads a base-branch coverage
 * artifact, which is the accepted risk #606 was filed with. A delta that was
 * never computed must not read as a delta that came back clean, so — exactly
 * as `CoverageInputState` does for the ladder (#554) — every field here is a
 * count or a fact about what the run *observed*, never a verdict, and a zero
 * denominator classifies as `unavailable` rather than as agreement (ADR 0010).
 */

import { readReportIndex } from './report-tier.js';
import { matchFile, type ChangedUnit, type ReportIndex } from './types.js';

/** One report's opinion of a file: covered lines out of coverable lines. */
export interface CoverageRatio {
  covered: number;
  coverable: number;
}

/** The base-vs-head comparison for a single touched file. */
export interface UnitCoverageDelta {
  path: string;
  base: CoverageRatio;
  head: CoverageRatio;
  /**
   * Percentage points lost, `baseRatio - headRatio` scaled to 100. Negative
   * when coverage **improved**, which is why `regressed` is a separate field
   * rather than a sign test the caller has to remember to get right.
   */
  dropPoints: number;
  regressed: boolean;
}

/**
 * What the delta run actually observed (#606), mirroring `CoverageInputState`.
 *
 * `unitsCompared` of `unitsTotal` is the load-bearing pair: it is the
 * denominator that tells a later reader whether "no regressions" meant
 * "compared and clean" or "never compared".
 */
export interface CoverageDeltaState {
  /** The `--base-coverage` path as given, or `null` when none was supplied. */
  baseRequested: string | null;
  /** A file exists at `baseRequested`. */
  baseFound: boolean;
  /** That file parsed into at least one usable record. */
  baseParsed: boolean;
  /** How many files the parsed base report carries coverage for. */
  filesInBaseReport: number;
  /** Touched units BOTH reports could speak to with a coverable denominator. */
  unitsCompared: number;
  /** Touched units submitted for comparison. */
  unitsTotal: number;
}

/**
 * `compared` (both reports spoke to every touched unit) | `partial` (some) |
 * `unavailable` (none — whatever the reason).
 */
export type CoverageDeltaStatus = 'compared' | 'partial' | 'unavailable';

/** Classify a {@link CoverageDeltaState}. Zero compared is never `compared`. */
export function coverageDeltaStatus(
  state: CoverageDeltaState,
): CoverageDeltaStatus {
  if (state.unitsTotal > 0 && state.unitsCompared === state.unitsTotal) {
    return 'compared';
  }
  return state.unitsCompared > 0 ? 'partial' : 'unavailable';
}

/**
 * Float-noise guard, in percentage points. Two reports of the same coverage can
 * differ in the last bits of a division; a drop under a tenth of a point is
 * arithmetic, not a regression.
 */
const DROP_EPSILON_POINTS = 0.1;

const EM_DASH = '\u{2014}';
const HEAD_ONLY =
  'were judged against the head report only, so a coverage REGRESSION on ' +
  'them cannot be detected by this run';

/**
 * The LOUD degradation line for a delta run, or `null` when every touched unit
 * was compared (nothing degraded, so nothing is said).
 *
 * A run that judged nothing (`unitsTotal === 0`) also returns `null`: it makes
 * no claim in either direction, and the caller's abstention path reports that.
 */
export function coverageDeltaNotice(state: CoverageDeltaState): string | null {
  const { baseRequested, baseFound, baseParsed, filesInBaseReport } = state;
  const { unitsCompared: compared, unitsTotal: total } = state;
  if (total === 0) return null;
  const status = coverageDeltaStatus(state);
  if (status === 'compared') return null;
  const dash = ` ${EM_DASH} `;

  if (status === 'partial') {
    return (
      `coverage delta partial${dash}head-only for ${total - compared} of ` +
      `${total} changed file(s); base report '${baseRequested}' matched ` +
      `${compared}. The unmatched file(s) ${HEAD_ONLY}`
    );
  }

  const head = `coverage delta unavailable${dash}head-only: `;
  const tail = `; ${total} changed file(s) ${HEAD_ONLY}`;
  if (baseRequested === null) {
    return `${head}no base coverage report was supplied${tail}`;
  }
  if (!baseFound) {
    return `${head}base report not found at '${baseRequested}'${tail}`;
  }
  if (!baseParsed) {
    return `${head}base report at '${baseRequested}' yielded no usable records${tail}`;
  }
  return (
    `${head}base report at '${baseRequested}' covers ${filesInBaseReport} ` +
    `file(s) but matched 0 of ${total} changed file(s)${tail}`
  );
}

/** Options for {@link resolveCoverageDelta}. */
export interface ResolveCoverageDeltaOptions {
  /** Coverage report for the PR's base ref (`--base-coverage`). */
  baseCoveragePath?: string | null;
  /** Coverage report for the PR head — the same file `--coverage` names. */
  headCoveragePath?: string | null;
}

/** {@link resolveCoverageDelta}'s findings-input plus the run's state. */
export interface ResolvedCoverageDelta {
  /** One entry per **compared** unit, in input order. Never per skipped unit. */
  deltas: UnitCoverageDelta[];
  state: CoverageDeltaState;
}

/**
 * Count a file's covered/coverable lines in one report index, or `null` when
 * the report cannot speak to the path with a usable denominator.
 *
 * `coverable` is the report's own instrumented set where the format declares
 * one (lcov, Cobertura), else the lines it recorded. A file present with an
 * empty record has a denominator of zero: a ratio there would be invented, so
 * the unit is skipped rather than scored — the same reason the ladder never
 * grades a unit it could not measure.
 */
function ratioFor(path: string, index: ReportIndex): CoverageRatio | null {
  const file = matchFile(path, index);
  if (file === null) return null;
  const coverableLines =
    file.coverable !== null
      ? [...file.coverable]
      : Object.keys(file.hits).map(Number);
  if (coverableLines.length === 0) return null;
  let covered = 0;
  for (const line of coverableLines) {
    if ((file.hits[line] ?? 0) > 0) covered++;
  }
  return { covered, coverable: coverableLines.length };
}

const percent = (r: CoverageRatio): number => (r.covered / r.coverable) * 100;

/**
 * Compare base-branch and head coverage over the touched units (#606).
 *
 * Returns one {@link UnitCoverageDelta} per unit **both** reports could score,
 * plus the {@link CoverageDeltaState} denominator. A unit either side cannot
 * score is silently absent from `deltas` and loudly absent from
 * `unitsCompared` — the notice, not the empty array, is what reports it.
 */
export function resolveCoverageDelta(
  units: ChangedUnit[],
  options: ResolveCoverageDeltaOptions = {},
): ResolvedCoverageDelta {
  const { baseCoveragePath = null, headCoveragePath = null } = options;

  const state: CoverageDeltaState = {
    baseRequested: baseCoveragePath,
    baseFound: false,
    baseParsed: false,
    filesInBaseReport: 0,
    unitsCompared: 0,
    unitsTotal: units.length,
  };

  if (baseCoveragePath === null) return { deltas: [], state };

  const baseRead = readReportIndex(baseCoveragePath);
  state.baseFound = baseRead.found;
  state.baseParsed = baseRead.index !== null;
  state.filesInBaseReport =
    baseRead.index === null ? 0 : Object.keys(baseRead.index).length;
  if (baseRead.index === null || headCoveragePath === null) {
    return { deltas: [], state };
  }

  const headRead = readReportIndex(headCoveragePath);
  if (headRead.index === null) return { deltas: [], state };

  const deltas: UnitCoverageDelta[] = [];
  for (const unit of units) {
    const base = ratioFor(unit.path, baseRead.index);
    const head = ratioFor(unit.path, headRead.index);
    if (base === null || head === null) continue;
    state.unitsCompared++;
    const dropPoints = percent(base) - percent(head);
    deltas.push({
      path: unit.path,
      base,
      head,
      dropPoints,
      regressed: dropPoints > DROP_EPSILON_POINTS,
    });
  }

  return { deltas, state };
}
