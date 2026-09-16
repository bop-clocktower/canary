/**
 * The shapes of the mission-briefing test charter's FACTS, and the pure
 * assembly of them (#593, spec D1/D4/D7).
 *
 * Deliberately dependency-free at runtime: every guardian import here is
 * type-only, and the wiring that actually runs the guardian's diff scoping and
 * Tier-0 coverage ladder lives in `briefing-cli.ts`. That keeps the honesty
 * rules — an unmeasured unit reads `unknown`, a missing inventory reads `null`
 * rather than empty — in one small, directly testable place, with nothing to
 * mock in order to exercise them.
 *
 * The judgment sections of a charter (what to explore by hand, which edge
 * cases the diff invites) are the skill's job, so this module never produces
 * them.
 */

import type { CoverageStatus } from '../guardian/diff-coverage/orchestrator.js';
import type { LineRange } from '../guardian/diff-coverage/types.js';

/** Whether an optional input was usable on this run. Never a verdict. */
export type Availability = 'available' | 'unavailable';

/**
 * What coverage established for ONE changed unit.
 *
 * `unknown` is the honest default and the only value a non-measured unit can
 * take: the graph and heuristic tiers are filename and call-graph inference,
 * which is not execution, so presenting either as `covered` would imply a
 * measurement nobody made (ADR 0010).
 */
export type UnitCoverage = 'covered' | 'uncovered' | 'unknown';

/** One changed unit, with only what was actually established about it. */
export interface BriefingUnit {
  path: string;
  added_ranges: LineRange[];
  coverage: UnitCoverage;
  /**
   * The Tier-0 evidence sentence when coverage MEASURED this unit, else null.
   *
   * Deliberately not a list of test names: a coverage report records which
   * LINES ran, never which test ran them, so naming a test here would be a
   * guess dressed as evidence.
   */
  execution_evidence: string | null;
  /**
   * Test files whose static import targets include this unit, or `null` when
   * no inventory was readable. `null` and `[]` are different claims — `[]` is
   * "the inventory was read and nothing imports it".
   */
  imported_by: string[] | null;
  /** Added lines a coverage run proved unhit. Empty unless measured. */
  uncovered_lines: number[];
  /** `.canary/critical-areas.json` rank, when one was readable. */
  rank_score?: number;
}

/** A unit the guardian filters kept out of the charter, and why. */
export interface BriefingSkip {
  path: string;
  reason: string;
}

/** The deterministic charter inputs (`canary briefing --json`). */
export interface BriefingFacts {
  schema_version: 1;
  /** The guardian's own one-line diff provenance, verbatim. */
  provenance: string;
  coverage: { status: CoverageStatus };
  risk_ranking: Availability;
  inventory: Availability;
  units: BriefingUnit[];
  skipped: BriefingSkip[];
}

export const BRIEFING_SCHEMA_VERSION = 1;

/** Source extensions stripped from a path to match an inventory target. */
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/;

/**
 * What a real coverage RUN established for one unit.
 *
 * Only the coverage-verified tier can produce this. The caller passes `null`
 * for a unit judged at the graph or heuristic tier, which is exactly how
 * inference is prevented from rendering as measurement.
 */
export interface MeasuredCoverage {
  covered: boolean;
  evidence: string;
  uncovered_lines: number[];
}

/** One scoped unit, plus whatever coverage measured about it. */
export interface ScopedUnit {
  path: string;
  added_ranges: LineRange[];
  measured: MeasuredCoverage | null;
}

/** Everything {@link assembleFacts} needs, already resolved by the caller. */
export interface FactsInput {
  provenance: string;
  coverageStatus: CoverageStatus;
  units: ScopedUnit[];
  skipped: BriefingSkip[];
  /** Inventory import targets by module path, or `null` when unreadable. */
  imports: Map<string, string[]> | null;
  /** `rank_score` by path, or `null` when unreadable. */
  ranks: Map<string, number> | null;
}

function unitFacts(unit: ScopedUnit, input: FactsInput): BriefingUnit {
  const rank = input.ranks?.get(unit.path);
  const moduleKey = unit.path.replace(SOURCE_EXT, '');
  const measured = unit.measured;
  const coverage: UnitCoverage =
    measured === null ? 'unknown' : measured.covered ? 'covered' : 'uncovered';
  return {
    path: unit.path,
    added_ranges: unit.added_ranges,
    coverage,
    execution_evidence: measured === null ? null : measured.evidence,
    imported_by:
      input.imports === null ? null : (input.imports.get(moduleKey) ?? []),
    uncovered_lines: measured === null ? [] : measured.uncovered_lines,
    ...(rank === undefined ? {} : { rank_score: rank }),
  };
}

/**
 * Assemble {@link BriefingFacts} from already-resolved inputs.
 *
 * Returns `null` for zero units so the caller abstains (ADR 0009 / criterion
 * 2) rather than rendering an empty charter — an empty charter reads as
 * "nothing here needs testing", which is the one thing it must never say by
 * accident.
 */
export function assembleFacts(input: FactsInput): BriefingFacts | null {
  if (input.units.length === 0) return null;
  const units = input.units.map((u) => unitFacts(u, input));
  // D6: highest risk first when a ranking was readable, else diff order with
  // the missing ranking STATED in the header rather than silently absent.
  if (input.ranks !== null) {
    units.sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));
  }
  return {
    schema_version: BRIEFING_SCHEMA_VERSION,
    provenance: input.provenance,
    coverage: { status: input.coverageStatus },
    risk_ranking: input.ranks === null ? 'unavailable' : 'available',
    inventory: input.imports === null ? 'unavailable' : 'available',
    units,
    skipped: input.skipped,
  };
}
