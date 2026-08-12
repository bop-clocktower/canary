/**
 * The coverage resolver's shared shapes, plus the small primitives every tier
 * needs to speak about them (line arithmetic, Python-parity parsing, path
 * matching). Leaf module: it imports nothing from the rest of the resolver.
 */

import { basename, extname } from 'node:path';

/** Confidence tier of a coverage signal (lower rank == higher fidelity). */
export enum Fidelity {
  CoverageVerified = 'coverage-verified',
  GraphVerified = 'graph-verified',
  Heuristic = 'heuristic',
}

const FIDELITY_RANK: Record<Fidelity, number> = {
  [Fidelity.CoverageVerified]: 0,
  [Fidelity.GraphVerified]: 1,
  [Fidelity.Heuristic]: 2,
};

/** 0=coverage, 1=graph, 2=heuristic. Lower means higher fidelity. */
export function fidelityRank(fidelity: Fidelity): number {
  return FIDELITY_RANK[fidelity];
}

/** Inclusive, 1-based `[start, end]` line range. */
export type LineRange = [number, number];

/**
 * A file changed by a diff, with the line ranges it *added*.
 *
 * `added_ranges` are inclusive, 1-based `[start, end]` line ranges.
 */
export interface ChangedUnit {
  path: string;
  added_ranges: LineRange[];
  symbol?: string;
}

/** The resolved coverage verdict for a single {@link ChangedUnit}. */
export interface CoverageResult {
  unit: ChangedUnit;
  covered: boolean;
  fidelity: Fidelity;
  evidence: string;
  uncovered_lines: number[];
  /**
   * How many of the unit's added lines the report could speak to (#655).
   *
   * The denominator that severity grading divides by. Only the coverage-verified
   * tier can know it — the graph and heuristic tiers never see per-line data —
   * so it is absent everywhere else, and consumers fall back to the added-line
   * count. Without it, a unit whose every coverable line is unhit inside a
   * mostly-uninstrumentable new file grades by a share diluted toward zero.
   */
  coverable_lines?: number;
}

/**
 * Build a {@link CoverageResult}, defaulting `uncovered_lines` to `[]`. Stands
 * in for the Python dataclass's `field(default_factory=list)` — the graph and
 * heuristic tiers never populate uncovered lines and rely on that default.
 */
export function makeResult(
  fields: Omit<CoverageResult, 'uncovered_lines'> & {
    uncovered_lines?: number[];
  },
): CoverageResult {
  return { ...fields, uncovered_lines: fields.uncovered_lines ?? [] };
}

/** `{line: hits}` — one file's per-line execution counts. */
export type LineHits = Record<number, number>;

/**
 * One file's coverage, plus what the report claims it could measure (#657).
 *
 * `coverable` is the set of lines the report says were instrumented. A changed
 * line outside it is **not coverable** — a comment, an import, a `type`
 * declaration, a blank line — and is scored by neither side of the ratio
 * (#655). `null` means the report never said, in which case every changed line
 * is treated as coverable and absence means uncovered.
 *
 * Which case a format lands in is a property of the format, not a flag:
 *
 * - **lcov / Cobertura** enumerate every instrumented line by construction, so
 *   the recorded lines *are* the coverable set.
 * - **coverage-json** says nothing unless the producer declares
 *   `instrumented_lines`; without it, the frozen v1 rule ("a line absent from
 *   both fields is uncovered") applies and `coverable` stays `null`.
 */
export interface FileCoverage {
  hits: LineHits;
  coverable: ReadonlySet<number> | null;
}

export type ReportIndex = Record<string, FileCoverage>;

/** Every line the report recorded is a line it could measure (lcov/Cobertura). */
export function selfDescribing(hits: LineHits): FileCoverage {
  return { hits, coverable: recordedLines(hits) };
}

/** The line numbers a hit map has records for. */
export function recordedLines(hits: LineHits): Set<number> {
  return new Set(Object.keys(hits).map(Number));
}

/** Split like Python's `str.splitlines()` for the common line endings. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Parse an integer the way Python's `int(str)` does for our inputs: optional
 * surrounding whitespace and sign, digits only. Returns `null` on failure
 * (Python would raise `ValueError`, which the callers catch-and-skip).
 */
export function pyInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** bool is excluded (a JSON true/false is not a valid line/hit count). */
export function isInt(value: unknown): value is number {
  // typeof boolean !== 'number', so booleans are already excluded here — the
  // JS analog of Python's explicit `not isinstance(value, bool)` guard.
  return typeof value === 'number' && Number.isInteger(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten inclusive `[start, end]` ranges into a sorted, de-duped line list. */
export function expandRanges(ranges: LineRange[]): number[] {
  const lines = new Set<number>();
  for (const [start, end] of ranges) {
    for (let ln = start; ln <= end; ln++) lines.add(ln);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Python's `Path(p).stem`: basename minus its final extension. */
export function stem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * True iff `candidate` and `target` name the same file path suffix.
 *
 * Exact match, or one is a suffix of the other on a **path-separator boundary**
 * (`a/b/foo.py` vs `foo.py`). Rejects loose substring collisions such as
 * `foobar.py` vs `bar.py` and `usermodels.py` vs `models.py` (FIX 6).
 */
export function pathBoundaryMatch(candidate: string, target: string): boolean {
  return (
    candidate === target ||
    candidate.endsWith('/' + target) ||
    target.endsWith('/' + candidate)
  );
}

/**
 * Look up one file's coverage for `path` in a report index.
 *
 * Prefers an EXACT path match. Otherwise falls back to a **boundary** suffix
 * match (report paths may be absolute, `./`-prefixed, or repo-relative). On
 * multiple boundary matches (duplicate basenames) the lookup is ambiguous and
 * returns `null` — the unit is then skipped and falls through rather than
 * binding to an arbitrary first match (FIX 6).
 */
export function matchFile(
  path: string,
  index: ReportIndex,
): FileCoverage | null {
  if (path in index) return index[path]!;
  const matches: FileCoverage[] = [];
  for (const [reportPath, file] of Object.entries(index)) {
    if (pathBoundaryMatch(reportPath, path)) matches.push(file);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Render ranges compactly, e.g. `[[12, 28], [30, 30]]` → `"12-28, 30"`. */
export function rangesStr(ranges: LineRange[]): string {
  return ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
}
