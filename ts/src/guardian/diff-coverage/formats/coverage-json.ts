/**
 * Reader for the canary coverage-json shape. The producer contract it enforces
 * is linted, field for field, by `./coverage-json-lint.ts` — the two are
 * deliberately kept side by side so they cannot drift.
 */

import {
  isInt,
  isRecord,
  pyInt,
  recordedLines,
  type LineHits,
  type FileCoverage,
  type ReportIndex,
} from '../types.js';

// The coverage-json contract version this build understands. Bumped only on a
// breaking change; the shape evolves additively (see
// docs/specs/coverage-json-contract.md).
export const COVERAGE_JSON_SCHEMA_VERSION = 1;

/** True when `schema_version` is absent or names a version this build reads. */
export function isSupportedSchemaVersion(version: unknown): boolean {
  if (version === undefined || version === null) return true;
  return isInt(version) && version === COVERAGE_JSON_SCHEMA_VERSION;
}

/**
 * Parse the canary coverage-json shape into `{path: {line: hits}}`.
 *
 * Supports `{"files": {"<path>": {"covered_lines": [...]}}}` and the same with
 * an explicit `line_hits` mapping. Unrecognized structure, or a
 * `schema_version` this build does not understand, → `null`. The v1 contract
 * is enforced strictly (integers only, 1-based lines, non-negative hits) so
 * this parser and `validateCoverageJson` stay in lockstep.
 */
export function parseCoverageJson(data: unknown): ReportIndex | null {
  if (!isRecord(data)) return null;
  // Refuse a version we don't understand rather than silently consuming its
  // v1-compatible parts and mislabeling the result coverage-verified.
  if (!isSupportedSchemaVersion(data['schema_version'])) return null;
  const files = data['files'];
  if (!isRecord(files)) return null;

  const index: ReportIndex = {};
  for (const [path, entry] of Object.entries(files)) {
    if (isRecord(entry)) index[String(path)] = parseFileEntry(entry);
  }
  return index;
}

/** Resolve one `files[path]` entry into its hit map and coverable set. */
function parseFileEntry(entry: Record<string, unknown>): FileCoverage {
  // line_hits is authoritative: covered_lines may add a line it didn't mention,
  // but never overrides an explicit hit count (so a `{"14": 0}` unhit line
  // stays uncovered).
  const recorded = readLineHits(entry['line_hits']);
  const hits: LineHits = { ...recorded };
  for (const lineno of coveredLineNumbers(entry['covered_lines'])) {
    if (!(lineno in recorded)) hits[lineno] = 1;
  }
  return {
    hits,
    coverable: declaredCoverable(entry['instrumented_lines'], hits),
  };
}

/** `line_hits` → hit map, dropping anything the v1 contract rejects. */
function readLineHits(value: unknown): LineHits {
  const hits: LineHits = {};
  if (!isRecord(value)) return hits;
  for (const [key, count] of Object.entries(value)) {
    // Integers only, 1-based line, non-negative hits (see docstring).
    if (!(isInt(count) && count >= 0)) continue;
    const lineno = pyInt(key);
    if (lineno === null || lineno < 1) continue;
    hits[lineno] = count;
  }
  return hits;
}

/** `covered_lines` → the line numbers that survive the v1 contract. */
function coveredLineNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((n): n is number => isInt(n) && n >= 1);
}

/**
 * Resolve a file entry's `instrumented_lines` declaration (#657).
 *
 * Returns the set of lines the report can speak to, or `null` when the producer
 * did not declare one — which is every v1 document written before this field
 * existed, and is why adding it changes no existing behaviour.
 *
 * A malformed declaration degrades to `null` rather than dropping the entry,
 * matching the parser's leniency everywhere else: one bad field costs that
 * field, never the file's coverage. `validateCoverageJson` is what makes the
 * degradation audible.
 *
 * Recorded lines are unioned in. A `line_hits` key outside the declared set is
 * a producer contradicting itself, and real measurement outranks a declaration
 * — dropping it would discard a hit count the producer actually took.
 */
function declaredCoverable(
  declaration: unknown,
  hits: LineHits,
): ReadonlySet<number> | null {
  if (!Array.isArray(declaration)) return null;
  const coverable = recordedLines(hits);
  for (const lineno of declaration) {
    if (isInt(lineno) && lineno >= 1) coverable.add(lineno);
  }
  return coverable;
}
