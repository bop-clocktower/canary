/**
 * Tiered, agent-free coverage-fidelity resolution for the PR guardian.
 *
 * Faithful TypeScript port of `agent/guardian/coverage.py`.
 *
 * Phase 1 (Tier 0) — resolves diff-coverage for a changed unit at the highest
 * available fidelity: an explicit coverage **report** beats a **graph**-derived
 * signal beats a naming **heuristic**. Each result is labeled with its
 * {@link Fidelity} so downstream findings can communicate confidence.
 *
 * SC-11 boundary: this module imports **no** agent/LLM module and never
 * references the `analyze_diff`/`get_impact` MCP tools. Graph coverage reads
 * the NDJSON `.harness/graph/graph.json` directly.
 *
 * Python→TS nuances (see the module-porting notes for the migration):
 *   - **XML**: Node has no built-in XML parser. The Cobertura reader is a
 *     minimal, targeted scanner pinned to the canonical
 *     `<coverage>...<class filename="..."><line number hits/>` shape. The
 *     entity-expansion / oversize / DOCTYPE guards are pre-parse *string*
 *     checks, so no XML library is involved in the security boundary.
 *   - **int vs. number**: `JSON.parse` collapses `3.0` to the integer `3`
 *     (JS has no int/float distinction), so — unlike Python's `json` — a
 *     literal `3.0` in a coverage-json cannot be rejected as "not an integer".
 *     Genuine non-integers (`3.7`) and booleans/strings are still rejected.
 *   - **UTF-8**: `read_text(encoding="utf-8")` raises on invalid bytes; Node's
 *     `readFileSync(path, 'utf-8')` silently substitutes U+FFFD. The report
 *     reader decodes with a *fatal* `TextDecoder` to preserve the Python
 *     "non-UTF-8 report → fall through" behavior.
 *
 * The implementation lives in `./coverage/`, one module per seam of the ladder
 * (#668). This file is the seam-free public face of it: every name the rest of
 * the codebase imports from `guardian/coverage.js` is re-exported here, so the
 * split moved no import in any consumer.
 */

export { coverageLimits } from './diff-coverage/formats/cobertura.js';
export { parseCoverageJson } from './diff-coverage/formats/coverage-json.js';
export {
  validateCoverageJson,
  type CoverageProblem,
} from './diff-coverage/formats/coverage-json-lint.js';
export { resolveFromGraph } from './diff-coverage/graph-tier.js';
export { resolveHeuristic } from './diff-coverage/heuristic-tier.js';
export {
  coverageDegradedNotice,
  coverageStatus,
  resolveCoverage,
  resolveCoverageWithInput,
  type CoverageInputState,
  type CoverageStatus,
  type ResolveCoverageOptions,
  type ResolvedCoverage,
} from './diff-coverage/orchestrator.js';
export {
  isSourcePath,
  isTestPath,
  isTestSupportPath,
} from './diff-coverage/paths.js';
export { resolveFromReport } from './diff-coverage/report-tier.js';
export { isTypeOnlyModule } from './diff-coverage/type-only.js';
export {
  fidelityRank,
  Fidelity,
  type ChangedUnit,
  type CoverageResult,
  type LineRange,
} from './diff-coverage/types.js';
