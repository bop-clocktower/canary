/**
 * Tier 0 deterministic PR guardian engine.
 *
 * Faithful TypeScript port of `agent/guardian/pr_check.py`.
 *
 * Scopes a git diff into changed units, resolves diff-coverage at the highest
 * available fidelity (see {@link module:./coverage}), builds fidelity-labeled
 * findings, honors `canary:allow-untested` suppressions, renders output, and
 * computes a soft/hard gate exit code.
 *
 * SC-11 boundary: imports **no** `AgentTier`/LLM/agent module and never
 * references the `analyze_diff`/`get_impact` MCP tools.
 *
 * Python→TS nuances (see the coverage-port notes for the migration):
 *   - **int vs. number**: Python's `json` distinguishes `2` (int) from `2.0`
 *     (float); `JSON.parse` collapses `2.0` to the integer `2`. The config
 *     coercers therefore accept a JSON `2.0` as a valid integer where Python
 *     would warn+default. A genuine fractional value (`1.5`) is still rejected
 *     on both. Documented, low-risk divergence.
 *   - **splitlines**: `str.splitlines()` drops a trailing newline's empty tail;
 *     the `splitLines` helper here keeps it. Harmless for the diff/suppression
 *     scanners (the phantom empty line never holds a `+`/annotation).
 *   - **CLI seam**: `read_diff` (stdin/subprocess/file passthrough) and the
 *     `pr-check` Typer command are intentionally NOT ported here — they belong
 *     to the later CLI wave. This module is the pure library logic.
 */

import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { readJsonWithWarning } from '../core/config-validation.js';
import { SkipEntry } from '../core/gate-result.js';
import { isAssertionFreeTest } from '../core/quality-scorer.js';
import {
  ChangedUnit,
  CoverageInputState,
  CoverageResult,
  Fidelity,
  LineRange,
  coverageDegradedNotice,
  coverageStatus,
  isSourcePath,
  isTestPath,
  isTestSupportPath,
  isTypeOnlyModule,
} from './coverage.js';
import { Severity, severitySortKey } from './impact-mapper.js';
import { ensureAscii } from '../util/ensure-ascii.js';

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// Suppression annotation: `// canary:allow-untested <reason>` or the `#`
// variant. A comment leader (`//` or `#`) is REQUIRED immediately before the
// token so a bare occurrence inside a string literal, docstring, or prose never
// clears the gate (FIX 1).
const SUPPRESS_RE = /(?:\/\/|#)\s*canary:allow-untested\s+(.+)/;

// Trailing inline-comment closers stripped from a captured reason.
const INLINE_COMMENT_CLOSERS = ['*/', '-->'];

/** Split like Python's `str.splitlines()` for the common line endings. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Collapse a sorted list of line numbers into inclusive `[start, end]` ranges.
 */
function mergeLines(lines: number[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges;
}

/**
 * Parse a unified diff into one {@link ChangedUnit} per file with added lines.
 *
 * Collects ADDED line numbers (from `@@` headers + `+` body lines) on the
 * new-file (`b/`) side. Deletions and context lines are ignored for range
 * purposes. Deleted files (`+++ /dev/null`) and files with no additions are
 * excluded from the result.
 */
export function scopeDiff(diffText: string): ChangedUnit[] {
  const addedByPath = new Map<string, number[]>();
  let currentPath: string | null = null;
  let newLineno = 0;
  let skipCurrent = false;
  let inHunk = false;

  for (const line of splitLines(diffText)) {
    if (line.startsWith('diff --git')) {
      // New file block begins → leave any prior hunk body; path is set by the
      // upcoming `+++ ` header.
      inHunk = false;
      currentPath = null;
      skipCurrent = false;
      continue;
    }

    // `--- `/`+++ ` are file headers ONLY before the first hunk of a file. Once
    // inside a hunk body a `+++ ...` line is an ADDED content line whose real
    // text is `++ ...` and must not be mistaken for a header (FIX 7).
    if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        skipCurrent = true;
        currentPath = null;
        continue;
      }
      skipCurrent = false;
      // Strip the conventional "b/" prefix.
      currentPath = target.startsWith('b/') ? target.slice(2) : target;
      if (!addedByPath.has(currentPath)) addedByPath.set(currentPath, []);
      continue;
    }

    if (!inHunk && line.startsWith('--- ')) {
      // Old-file header; ignored (path comes from +++).
      continue;
    }

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      newLineno = Number.parseInt(hunk[1]!, 10);
      inHunk = true;
      continue;
    }

    if (skipCurrent || currentPath === null) continue;

    if (line.startsWith('+')) {
      addedByPath.get(currentPath)!.push(newLineno);
      newLineno += 1;
    } else if (line.startsWith('-')) {
      // Removed line: does not advance the new-file counter.
      continue;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, ignore.
      continue;
    } else {
      // Context line (leading space) or blank — advances new-file counter.
      newLineno += 1;
    }
  }

  const units: ChangedUnit[] = [];
  for (const [path, lines] of addedByPath) {
    if (lines.length === 0) continue;
    units.push({ path, added_ranges: mergeLines(lines) });
  }
  return units;
}

// FIX 2 (signal-quality): a changed file whose ADDED lines are ONLY imports /
// re-exports (no real declarations or logic) is a barrel/index file
// (`index.ts`, `__init__.py`) and should not be flagged as untested.
//
// Conservative contract: a line counts as re-export/import iff it matches one
// of these; a real declaration DISQUALIFIES the whole file (flag it). When
// unsure, treat as NOT a barrel — a false skip is worse than a false flag.
const REEXPORT_PATTERNS: RegExp[] = [
  // TS/JS.
  /^\s*import\b/,
  /^\s*export\s+\*\s+from\b/,
  /^\s*export\s+\{[^}]*\}\s+from\b/,
  /^\s*export\s+\{[^}]*\}\s*;?\s*$/, // local re-export
  /^\s*export\s+\{?\s*default\b.*\}?\s+from\b/,
  /^\s*export\s+default\s+\w+\s*;?\s*$/,
  // Python.
  /^\s*from\s+\S+\s+import\b/,
  /^\s*import\s+\w/,
  /^\s*__all__\s*=/,
];

// Full-line comment leaders / block-comment scaffolding treated as NEUTRAL.
const COMMENT_LINE_RE = /^\s*(?:\/\/|#|\/\*|\*)/;
const BLOCK_COMMENT_CLOSE_RE = /\*\/\s*$/;
// A bare string entry inside an `__all__ = [ ... ]` list (neutral).
const ALL_LIST_ENTRY_RE = /^\s*["'][^"']*["']\s*,?\s*$/;
const ALL_LIST_CLOSE_RE = /^\s*\]/;

/** Return True for blank lines and full-line comments (ignored for barrels). */
function isNeutralLine(stripped: string): boolean {
  if (!stripped) return true;
  if (COMMENT_LINE_RE.test(stripped)) return true;
  return BLOCK_COMMENT_CLOSE_RE.test(stripped) && stripped.startsWith('*');
}

/**
 * Map each changed file to the CONTENT of its added (`+`) lines.
 *
 * Mirrors {@link scopeDiff}'s parser but captures the added-line *text* (the
 * `+` stripped) rather than line numbers. Deleted files (`+++ /dev/null`) are
 * excluded; a `+++ ` line inside a hunk body is added content, not a header
 * (same FIX 7 guard as `scopeDiff`).
 */
function addedContentByPath(diffText: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let currentPath: string | null = null;
  let skipCurrent = false;
  let inHunk = false;

  for (const line of splitLines(diffText)) {
    if (line.startsWith('diff --git')) {
      inHunk = false;
      currentPath = null;
      skipCurrent = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        skipCurrent = true;
        currentPath = null;
        continue;
      }
      skipCurrent = false;
      currentPath = target.startsWith('b/') ? target.slice(2) : target;
      if (!added.has(currentPath)) added.set(currentPath, []);
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) continue;
    if (HUNK_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (skipCurrent || currentPath === null) continue;
    if (line.startsWith('+')) {
      added.get(currentPath)!.push(line.slice(1));
    }
  }
  return added;
}

/**
 * Return True iff every non-neutral added line is a pure import/re-export.
 *
 * Requires at least one actual import/re-export line (a file of only comments
 * is NOT a barrel — conservatively flagged). Any non-neutral line that is not
 * an import/re-export (a real declaration, JSX, or logic) disqualifies the
 * file. Handles a multi-line `__all__ = [ ... ]` list: its string entries and
 * closing bracket are neutral.
 */
function isReexportOnly(addedLines: string[]): boolean {
  let hasReexport = false;
  let inAllList = false;
  for (const raw of addedLines) {
    const stripped = raw.trim();
    if (inAllList) {
      if (ALL_LIST_CLOSE_RE.test(stripped)) {
        inAllList = false;
        continue;
      }
      if (isNeutralLine(stripped) || ALL_LIST_ENTRY_RE.test(stripped)) continue;
      return false; // unexpected content inside __all__ → not a barrel
    }
    if (isNeutralLine(stripped)) continue;
    if (REEXPORT_PATTERNS.some((pat) => pat.test(stripped))) {
      hasReexport = true;
      // An `__all__ = [` that does not close on the same line opens a list.
      if (
        stripped.startsWith('__all__') &&
        stripped.includes('[') &&
        !stripped.includes(']')
      ) {
        inAllList = true;
      }
      continue;
    }
    return false; // a real declaration / logic line → not a barrel
  }
  return hasReexport;
}

/**
 * Return the set of file paths whose added lines are ONLY imports/re-exports.
 *
 * These are barrel/index files (`index.ts`, `__init__.py`) that merely forward
 * other modules' symbols and carry no logic of their own, so they should not be
 * flagged as untested (FIX 2). Detection reads the diff's added (`+`) line
 * CONTENT, mirroring {@link scopeDiff}.
 */
export function findReexportOnly(diffText: string): Set<string> {
  const result = new Set<string>();
  for (const [path, lines] of addedContentByPath(diffText)) {
    if (isReexportOnly(lines)) result.add(path);
  }
  return result;
}

/** Escape a single character for literal use inside a RegExp (`re.escape`). */
function escapeReChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return True iff `path` matches a glob `pattern` supporting `**`.
 *
 * Translation rules (segment-aware, forward-slash paths):
 *
 *   - `**` matches any number of characters including `/` (any depth, incl.
 *     zero directories). A leading double-star slash also matches zero leading
 *     segments.
 *   - `*` matches any run of characters *within a single segment* (no `/`).
 *   - `?` matches a single non-`/` character.
 *
 * The pattern is anchored to the full path (implicit `^...$`).
 */
function globMatches(path: string, pattern: string): boolean {
  const parts: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      // `**/` → any leading segments including none.
      parts.push('(?:.*/)?');
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      parts.push('.*');
      i += 2;
    } else if (pattern[i] === '*') {
      parts.push('[^/]*');
      i += 1;
    } else if (pattern[i] === '?') {
      parts.push('[^/]');
      i += 1;
    } else {
      parts.push(escapeReChar(pattern[i]!));
      i += 1;
    }
  }
  return new RegExp(`^${parts.join('')}$`).test(path);
}

/**
 * Partition `units` into `[kept, skipped]` by `skipGlobs` (SC-2).
 *
 * A unit is *skipped* iff its `.path` matches ANY glob in `skipGlobs`.
 * Order-preserving in both partitions. An empty `skipGlobs` keeps every unit
 * (`[units, []]`).
 */
export function filterSkipped(
  units: ChangedUnit[],
  skipGlobs: string[],
): [ChangedUnit[], ChangedUnit[]] {
  if (skipGlobs.length === 0) return [units, []];
  const kept: ChangedUnit[] = [];
  const skipped: ChangedUnit[] = [];
  for (const unit of units) {
    if (skipGlobs.some((glob) => globMatches(unit.path, glob))) {
      skipped.push(unit);
    } else {
      kept.push(unit);
    }
  }
  return [kept, skipped];
}

/**
 * Partition `units` into `[kept, testUnits]` by test-path (FIX A).
 *
 * A test file does not itself need a test, so a changed unit whose path looks
 * like a test (`tests/**`, `test_*.py`, `*.test.*`, `*.spec.*` — the single
 * {@link isTestPath} predicate reused by the graph resolver) is dropped before
 * findings are built. Order-preserving in both partitions.
 */
export function filterTestUnits(
  units: ChangedUnit[],
): [ChangedUnit[], ChangedUnit[]] {
  const kept: ChangedUnit[] = [];
  const testUnits: ChangedUnit[] = [];
  for (const unit of units) {
    if (isTestPath(unit.path)) {
      testUnits.push(unit);
    } else {
      kept.push(unit);
    }
  }
  return [kept, testUnits];
}

/**
 * Partition `units` into `[kept, supportUnits]` by test-support name (#565).
 *
 * The sibling of {@link filterTestUnits} for files that are test infrastructure
 * by *filename idiom* rather than by test-path convention — a pytest
 * `conftest`, a Playwright fixture module. See {@link isTestSupportPath} for
 * why the match is component-scoped and why it stays out of `isTestPath`.
 *
 * Runs before coverage is resolved, so the suppression holds at **every**
 * fidelity tier — matching where the existing `fixtures/` convention already
 * sits in {@link DEFAULT_SKIP_GLOBS}. An lcov row proving a fixture's lines are
 * uncovered is true and still cannot make "this needs a test" satisfiable.
 *
 * Partitioned separately from `testUnits` rather than folded into it: those
 * feed {@link buildWeakTestFindings}, and a conftest asserts nothing by design,
 * so folding would swap one bogus finding for another. Order-preserving in both.
 */
export function filterTestSupportUnits(
  units: ChangedUnit[],
): [ChangedUnit[], ChangedUnit[]] {
  const kept: ChangedUnit[] = [];
  const supportUnits: ChangedUnit[] = [];
  for (const unit of units) {
    if (isTestSupportPath(unit.path)) supportUnits.push(unit);
    else kept.push(unit);
  }
  return [kept, supportUnits];
}

/**
 * Partition `units` into `[kept, typeOnlyUnits]` by type-only content (#562).
 *
 * The sibling of {@link filterTestSupportUnits} for modules that contain no
 * runtime code at all. Runs pre-resolution for the same reason: a type
 * declaration has no runtime existence at ANY tier, so a suppression scoped to
 * one tier would leave the measured false positives in place — which is
 * precisely how #413 missed this class. See {@link isTypeOnlyModule} for why
 * content, not the filename, is the evidence.
 *
 * `repoRoot` is needed because the decision requires reading the file; a unit
 * whose file cannot be read keeps its finding. Order-preserving in both.
 */
export function filterTypeOnlyUnits(
  units: ChangedUnit[],
  repoRoot: string,
): [ChangedUnit[], ChangedUnit[]] {
  const kept: ChangedUnit[] = [];
  const typeOnlyUnits: ChangedUnit[] = [];
  for (const unit of units) {
    if (isTypeOnlyModule(unit.path, repoRoot)) typeOnlyUnits.push(unit);
    else kept.push(unit);
  }
  return [kept, typeOnlyUnits];
}

/**
 * Default glob layer over the {@link isSourcePath} extension floor (#413).
 *
 * These paths carry a *source* extension but still have nothing a naming
 * heuristic could judge: ambient type declarations have no runtime behavior,
 * and generated clients/stubs are regenerated from a schema rather than
 * hand-authored. An explicit `heuristicExclude` in config (even `[]`) replaces
 * this list; the extension floor is NOT config-defeatable.
 */
export const DEFAULT_HEURISTIC_EXCLUDE_GLOBS: readonly string[] = [
  '**/*.d.ts',
  '**/__generated__/**',
  '**/generated/**',
  '**/*.generated.*',
  '**/*_pb2.py',
  '**/*.pb.go',
];

/**
 * Partition coverage results, dropping heuristic false positives (#413).
 *
 * A result is dropped iff ALL of:
 *
 *   - its fidelity is `HEURISTIC` (the last-resort naming tier), AND
 *   - it is **uncovered** (a covered result raises no finding anyway), AND
 *   - its path is not program source ({@link isSourcePath}) OR it matches an
 *     `excludeGlobs` entry.
 *
 * The narrowness is the point. A `COVERAGE_VERIFIED` or `GRAPH_VERIFIED`
 * verdict on the very same path rests on real evidence (an lcov row, a graph
 * edge) and still fires — the suppression is scoped to the tier, never to the
 * path. Returns `[kept, dropped]`, order-preserving in both.
 *
 * Why this matters beyond noise: the soft→hard gate promotion is earned by
 * reviewer adjudication feeding `precision = TP / (TP + FP)`. A repo that
 * routinely touches config files accumulated 👎 on findings that could never
 * have been true, holding it below its promotion bar indefinitely.
 */
export function filterHeuristicNoise(
  results: CoverageResult[],
  excludeGlobs: string[],
): [CoverageResult[], CoverageResult[]] {
  const kept: CoverageResult[] = [];
  const dropped: CoverageResult[] = [];
  for (const result of results) {
    const ineligible =
      result.fidelity === Fidelity.Heuristic &&
      !result.covered &&
      (!isSourcePath(result.unit.path) ||
        excludeGlobs.some((glob) => globMatches(result.unit.path, glob)));
    if (ineligible) dropped.push(result);
    else kept.push(result);
  }
  return [kept, dropped];
}

/**
 * A single guardian finding about a changed unit.
 *
 * Phase 1 emits only `untested-new-code` findings (`weak-test` is a Tier 1+
 * concern). `severity` reuses {@link Severity}; `fidelity` carries the
 * confidence tier from the underlying coverage signal.
 */
export class GuardianFinding {
  path: string;
  unit: string;
  kind: string;
  fidelity: Fidelity;
  severity: Severity;
  evidence: string;
  suggestion: string;
  suppressed: boolean;
  suppression_reason: string | null;
  // Inclusive 1-based [start, end] ranges the diff ADDED for this unit. Carried
  // from the CoverageResult/ChangedUnit so suppression can be scoped to only
  // the changed lines (FIX 1). Empty → suppression falls back to a whole-file
  // scan (still comment-leader gated).
  added_ranges: LineRange[];
  // The specific 1-based line numbers the coverage run proved unhit.
  //
  // Only the COVERAGE_VERIFIED tier can supply these — the graph and heuristic
  // tiers answer "is this reached at all?", not "which lines ran" — so an empty
  // array means "this tier does not know", NEVER "nothing is uncovered". The
  // renderer must therefore omit the detail rather than print an empty list,
  // which would read as a measurement that came back clean.
  uncovered_lines: number[];

  constructor(init: {
    path: string;
    unit: string;
    kind?: string;
    fidelity?: Fidelity;
    severity?: Severity;
    evidence?: string;
    suggestion?: string;
    suppressed?: boolean;
    suppression_reason?: string | null;
    added_ranges?: LineRange[];
    uncovered_lines?: number[];
  }) {
    this.path = init.path;
    this.unit = init.unit;
    this.kind = init.kind ?? 'untested-new-code';
    this.fidelity = init.fidelity ?? Fidelity.Heuristic;
    this.severity = init.severity ?? Severity.HIGH;
    this.evidence = init.evidence ?? '';
    this.suggestion = init.suggestion ?? '';
    this.suppressed = init.suppressed ?? false;
    this.suppression_reason = init.suppression_reason ?? null;
    this.added_ranges = init.added_ranges ?? [];
    this.uncovered_lines = init.uncovered_lines ?? [];
  }
}

/** Basename minus its extension — the token a heuristic test-file match uses. */
function pathStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Render ranges as `44-49, 52-56, 58`, capped at `max` with a `+N more` tail.
 *
 * The cap is a budget guard, not cosmetics: a file with hundreds of scattered
 * uncovered lines would otherwise produce a single table cell long enough to
 * push other findings out of the comment entirely (#457).
 */
function rangeList(ranges: LineRange[], max = 6): string {
  const shown = ranges
    .slice(0, max)
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));
  const rest = ranges.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/**
 * The deterministic next action for a finding.
 *
 * Every branch states only what its tier actually established, because a
 * suggestion that guesses (naming a test file that does not exist, say) is
 * worse than none: it sends the reader somewhere before they distrust it. The
 * coverage tier can name lines; the graph tier can name a symbol; the heuristic
 * tier knows only that no filename matched, and says exactly that.
 */
function suggestionFor(
  path: string,
  unit: string,
  fidelity: Fidelity,
  uncovered: number[],
): string {
  const symbol = unit && unit !== path ? unit : pathStem(path);
  if (fidelity === Fidelity.CoverageVerified && uncovered.length > 0) {
    // The path is deliberately not repeated: the record carries it as a
    // sibling field, and the comment already shows it in the File column.
    return `extend a test to execute lines ${rangeList(mergeLines(uncovered))}.`;
  }
  if (fidelity === Fidelity.GraphVerified) {
    return `add a test that calls \`${symbol}\`, directly or through a caller.`;
  }
  if (fidelity === Fidelity.Heuristic) {
    return `no test file mentions \`${pathStem(path)}\` — name a test after it, or reference it from an existing test.`;
  }
  return `add a test covering \`${symbol}\`.`;
}

// Thresholds for the coverage-verified severity split (#553). Volume is a line
// count; share is the fraction of the unit's ADDED lines that came back unhit.
//
// The pair matters more than either number: volume alone ranks a 30-line
// function that is 10% uncovered above a 3-line function nothing executes, and
// share alone ranks a one-line addition alongside a 132-line one.
const CRITICAL_UNCOVERED_LINES = 20;
const CRITICAL_UNCOVERED_SHARE = 0.8;
const HIGH_UNCOVERED_LINES = 5;
const HIGH_UNCOVERED_SHARE = 0.5;

/** Total lines a diff added for a unit, summed over its inclusive ranges. */
function addedLineCount(ranges: readonly LineRange[]): number {
  return ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

/**
 * The fraction of what the report could speak to that came back unhit (#655).
 *
 * The denominator is the unit's **coverable** lines — added lines overstate it,
 * because on a new file that is largely imports, types and blanks most changed
 * lines were never instrumented at all, and dividing by them drives every share
 * toward zero. Where the count is unknown (the graph and heuristic tiers, which
 * are not graded by share anyway) it falls back to the added-line count, so
 * grades predating that field are unchanged. An unknown denominator yields a
 * full share rather than a low one — an absent measurement must never read as a
 * good score (ADR 0010).
 */
function uncoveredShare(result: CoverageResult, uncovered: number): number {
  const denominator =
    result.coverable_lines ?? addedLineCount(result.unit.added_ranges);
  return denominator > 0 ? uncovered / denominator : 1;
}

/**
 * Severity for an uncovered **coverage-verified** result (#553).
 *
 * Only this tier can be graded, because only this tier knows *which* lines ran
 * (see the `uncovered_lines` comment on {@link GuardianFinding}). The grade combines
 * how much is unhit with how much of the change that represents:
 *
 *   - `CRITICAL` — a large block (>= 20 lines) that is essentially untouched
 *     (>= 80% unhit). Nothing executes it; this is what a gate should stop.
 *   - `HIGH` — a meaningful volume (>= 5 lines) *or* a concentrated gap
 *     (>= 50% unhit).
 *   - `MEDIUM` — a handful of lines inside a change that is otherwise tested.
 *     Real, still reported, not worth blocking a PR over.
 *
 * Both unknowns escalate rather than downgrade. No line detail means the tier
 * could not say which lines were unhit, not that few were; no added-line count
 * means the share denominator is unknown. An absent measurement must never read
 * as a low score (ADR 0010) — that is the same silent-abstention shape this
 * whole module exists to avoid.
 */
function coverageVerifiedSeverity(result: CoverageResult): Severity {
  const uncovered = result.uncovered_lines?.length ?? 0;
  if (uncovered === 0) return Severity.HIGH;

  const share = uncoveredShare(result, uncovered);

  if (
    uncovered >= CRITICAL_UNCOVERED_LINES &&
    share >= CRITICAL_UNCOVERED_SHARE
  )
    return Severity.CRITICAL;
  if (uncovered >= HIGH_UNCOVERED_LINES || share >= HIGH_UNCOVERED_SHARE)
    return Severity.HIGH;
  return Severity.MEDIUM;
}

/**
 * Turn uncovered coverage results into fidelity-labeled findings.
 *
 * Only **uncovered** results become findings. Severity policy:
 *
 *   - `COVERAGE_VERIFIED` uncovered → graded by
 *     {@link coverageVerifiedSeverity} (`CRITICAL` / `HIGH` / `MEDIUM`)
 *   - `GRAPH_VERIFIED` uncovered    → `HIGH`
 *   - `HEURISTIC` uncovered         → `MEDIUM` (lower confidence)
 *
 * The graph and heuristic tiers stay flat on purpose: neither can measure how
 * much of a unit is unhit, so any spread across them would be invented.
 *
 * Results are sorted by severity sort-key (critical → low).
 */
export function buildFindings(results: CoverageResult[]): GuardianFinding[] {
  const findings: GuardianFinding[] = [];
  for (const result of results) {
    if (result.covered) continue;
    let severity: Severity;
    if (result.fidelity === Fidelity.CoverageVerified)
      severity = coverageVerifiedSeverity(result);
    else if (result.fidelity === Fidelity.Heuristic) severity = Severity.MEDIUM;
    else severity = Severity.HIGH;
    const unit = result.unit;
    const uncovered = [...(result.uncovered_lines ?? [])];
    findings.push(
      new GuardianFinding({
        path: unit.path,
        unit: unit.symbol || unit.path,
        fidelity: result.fidelity,
        severity,
        evidence: result.evidence,
        suggestion: suggestionFor(
          unit.path,
          unit.symbol || unit.path,
          result.fidelity,
          uncovered,
        ),
        added_ranges: [...unit.added_ranges],
        uncovered_lines: uncovered,
      }),
    );
  }
  return [...findings].sort(
    (a, b) => severitySortKey(a.severity) - severitySortKey(b.severity),
  );
}

// Map a test file's extension to the framework whose assertion/test patterns
// the quality scorer should use. Unknown → pytest (the scorer's own fallback).
const TEST_FRAMEWORK_BY_EXT: Record<string, string> = {
  '.py': 'pytest',
  '.ts': 'vitest',
  '.tsx': 'vitest',
  '.js': 'vitest',
  '.jsx': 'vitest',
  '.mjs': 'vitest',
  '.cjs': 'vitest',
};

function frameworkForTestPath(path: string): string {
  return TEST_FRAMEWORK_BY_EXT[extname(path).toLowerCase()] ?? 'pytest';
}

// A test-function signature / decorator / block-close / comment — lines that
// are not a test *body*. If a diff's added lines are ONLY these (e.g. a rename
// that adds just `def test_new():` while the asserting body stays as context),
// there is no added body to judge and we must not flag it.
const TEST_SIGNATURE_RE =
  /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*(?:it|test|describe)\s*\(/;

const BLOCK_DELIMITERS = new Set(['})', '});', '}', ')', '{']);

/**
 * True iff the added lines contain a real body line — not just a test
 * signature, decorator, comment, or a bare block delimiter.
 */
function hasAddedTestBody(added: string[]): boolean {
  for (const line of added) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (
      stripped.startsWith('#') ||
      stripped.startsWith('//') ||
      stripped.startsWith('@') ||
      stripped.startsWith('*') ||
      stripped.startsWith('/*')
    ) {
      continue;
    }
    if (BLOCK_DELIMITERS.has(stripped)) continue;
    if (TEST_SIGNATURE_RE.test(line)) continue;
    return true;
  }
  return false;
}

/**
 * The declaration line of a single test, per framework family (#747).
 *
 * Narrower than {@link TEST_SIGNATURE_RE} on purpose: `describe(` opens a
 * *group*, and judging assertion presence over a whole describe block would
 * suppress a genuinely empty test sitting beside an asserting sibling. A
 * modifier chain (`it.only`, `test.each`) still opens one test, so it counts.
 */
const TEST_DECL_PY = /^\s*(?:async\s+)?def\s+test\w*\s*\(/;
const TEST_DECL_JS = /^\s*(?:async\s+)?(?:it|test)(?:\.\w+)*\s*\(/;

function testDeclRe(framework: string): RegExp {
  return framework === 'pytest' ? TEST_DECL_PY : TEST_DECL_JS;
}

/** Indentation width of `line`, counting a tab as one column. */
function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

// String literals and line comments are blanked before delimiter counting, so
// a brace inside `'a { b'` or a trailing `// }` cannot unbalance a block.
const JS_STRING_OR_COMMENT =
  /(['"`])(?:\\.|(?!\1).)*?\1|\/\/.*$|\/\*[\s\S]*?\*\//g;

/**
 * One file's new-side lines as the diff shows them: `lineNo -> text`, plus the
 * set of line numbers that were ADDED (#747).
 *
 * The weak-test heuristic needs context lines, not only `+` lines, because the
 * assertion it is looking for is very often exactly the context line below the
 * hunk. Line numbering follows {@link scopeDiff} so the two agree on what line
 * 41 is.
 */
interface VisibleFile {
  text: Map<number, string>;
  added: Set<number>;
}

/** Mutable cursor carried across the lines of one diff. */
interface DiffCursor {
  current: VisibleFile | null;
  newLineno: number;
  skipCurrent: boolean;
  inHunk: boolean;
}

/**
 * Consume a `diff --git` / `+++` / `---` / `@@` line, returning whether the
 * line was a header. Split out from the content handling so neither half has
 * to carry the other's branches.
 */
function applyDiffHeader(
  line: string,
  cur: DiffCursor,
  files: Map<string, VisibleFile>,
): boolean {
  if (line.startsWith('diff --git')) {
    cur.inHunk = false;
    cur.current = null;
    cur.skipCurrent = false;
    return true;
  }
  if (!cur.inHunk && line.startsWith('+++ ')) {
    const target = line.slice(4).trim();
    if (target === '/dev/null') {
      cur.skipCurrent = true;
      cur.current = null;
      return true;
    }
    cur.skipCurrent = false;
    const path = target.startsWith('b/') ? target.slice(2) : target;
    cur.current = files.get(path) ?? { text: new Map(), added: new Set() };
    files.set(path, cur.current);
    return true;
  }
  if (!cur.inHunk && line.startsWith('--- ')) return true;
  const hunk = HUNK_RE.exec(line);
  if (hunk) {
    cur.newLineno = Number.parseInt(hunk[1]!, 10);
    cur.inHunk = true;
    return true;
  }
  return false;
}

/** Record one content line against the file the cursor is pointing at. */
function applyDiffContent(line: string, cur: DiffCursor): void {
  const file = cur.current;
  if (!file) return;
  // `-` is gone from the new file and `\` is the no-newline marker; neither
  // occupies a line number on the `+` side.
  if (line.startsWith('-') || line.startsWith('\\')) return;
  const added = line.startsWith('+');
  file.text.set(cur.newLineno, line.slice(1));
  if (added) file.added.add(cur.newLineno);
  cur.newLineno += 1;
}

function visibleLinesByPath(diffText: string): Map<string, VisibleFile> {
  const files = new Map<string, VisibleFile>();
  const cur: DiffCursor = {
    current: null,
    newLineno: 0,
    skipCurrent: false,
    inHunk: false,
  };

  for (const line of splitLines(diffText)) {
    if (applyDiffHeader(line, cur, files)) continue;
    if (cur.skipCurrent || cur.current === null) continue;
    applyDiffContent(line, cur);
  }
  return files;
}

/**
 * The line the enclosing test declaration sits on, or `null` when none is
 * visible (#747).
 *
 * Walks up through the CONTIGUOUS visible run only: a gap between hunks means
 * the lines between are unknown, so a declaration on the far side of it is not
 * evidence about this line. Returning `null` is the abstention — a changed line
 * whose enclosing test cannot be resolved (a Playwright `setup(...)` fixture, a
 * bare helper) is not judged at all rather than reported as assertion-free.
 */
function enclosingTestDecl(
  file: VisibleFile,
  lineNo: number,
  declRe: RegExp,
): number | null {
  for (let n = lineNo; file.text.has(n); n--) {
    if (declRe.test(file.text.get(n)!)) return n;
  }
  return null;
}

/**
 * The last line of the test block opened at `start`, bounded by what the diff
 * shows (#747).
 *
 * Python closes on the first non-blank line indented no deeper than the `def`;
 * JS/TS closes when the delimiter depth opened by the declaration returns to
 * zero. When neither lands inside the visible run the span is truncated at its
 * end — the assertion search is then over less than the whole block, which can
 * still miss an assertion further down. That residual is accepted: it is a
 * strictly smaller window of error than scoring the added lines alone, which is
 * what #747 measured, and widening the span past what the diff shows would mean
 * reading the working tree, which this function deliberately does not do.
 */
function testBlockEnd(
  file: VisibleFile,
  start: number,
  isPython: boolean,
): number {
  let last = start;
  if (isPython) {
    const declIndent = indentWidth(file.text.get(start)!);
    for (let n = start + 1; file.text.has(n); n++) {
      const text = file.text.get(n)!;
      if (text.trim() && indentWidth(text) <= declIndent) return n - 1;
      last = n;
    }
    return last;
  }
  let depth = 0;
  let opened = false;
  for (let n = start; file.text.has(n); n++) {
    const text = file.text.get(n)!.replace(JS_STRING_OR_COMMENT, '');
    for (const ch of text) {
      if (ch === '{' || ch === '(') {
        depth += 1;
        opened = true;
      } else if (ch === '}' || ch === ')') depth -= 1;
    }
    last = n;
    if (opened && depth <= 0) return n;
  }
  return last;
}

/**
 * True iff some test block touched by `unit`'s added lines asserts nothing.
 *
 * A block qualifies for judgement only when it is resolvable AND at least one
 * of its own added lines is a real body line — the FP-3 rename guard, applied
 * per block rather than per file so a rename in one test cannot excuse an empty
 * one elsewhere in the same diff. Blocks are visited once each.
 */
function weakBlockIn(
  file: VisibleFile,
  unit: ChangedUnit,
  framework: string,
): boolean {
  const declRe = testDeclRe(framework);
  const isPython = framework === 'pytest';
  const seen = new Set<number>();
  for (const lineNo of linesInRanges(unit.added_ranges)) {
    const start = enclosingTestDecl(file, lineNo, declRe);
    if (start === null || seen.has(start)) continue;
    seen.add(start);
    const end = testBlockEnd(file, start, isPython);
    const span: string[] = [];
    const addedInBlock: string[] = [];
    for (let n = start; n <= end; n++) {
      const text = file.text.get(n);
      if (text === undefined) continue;
      span.push(text);
      if (file.added.has(n)) addedInBlock.push(text);
    }
    if (!hasAddedTestBody(addedInBlock)) continue;
    if (isAssertionFreeTest(span.join('\n'), framework)) return true;
  }
  return false;
}

/**
 * Advisory `weak-test` findings for ADDED tests that assert nothing.
 *
 * Consumes the test-path units {@link filterTestUnits} sets aside (a test file
 * needs no test of its own, but an added test that asserts nothing is itself a
 * gap). A high-precision signal by construction: a snapshot or table-driven
 * test still matches an assertion pattern, so it is not flagged.
 *
 * #747: the span scored is the ENCLOSING TEST BLOCK of each added line, not the
 * added lines themselves. Scoring the added lines alone reported every
 * arrange/act-only edit as assertion-free, because a test's setup is edited far
 * more often than its `expect` — six such findings, all wrong, in the run that
 * produced the report. A changed line whose enclosing test cannot be resolved
 * from the diff is ABSTAINED on, never reported.
 *
 * These findings are `LOW`/`weak-test` and are **never** gated (see
 * {@link computeExitCode}): they surface, never block.
 */
export function buildWeakTestFindings(
  testUnits: ChangedUnit[],
  diffText: string,
): GuardianFinding[] {
  const addedByPath = addedContentByPath(diffText);
  const visibleByPath = visibleLinesByPath(diffText);
  const findings: GuardianFinding[] = [];
  for (const unit of testUnits) {
    const added = addedByPath.get(unit.path);
    if (!added || added.length === 0) continue;
    // A rename adds only the signature line (body is unchanged context) —
    // nothing new to judge, so don't flag it (FP guard).
    if (!hasAddedTestBody(added)) continue;
    const framework = frameworkForTestPath(unit.path);
    const file = visibleByPath.get(unit.path);
    if (!file) continue;
    if (weakBlockIn(file, unit, framework)) {
      findings.push(
        new GuardianFinding({
          path: unit.path,
          unit: unit.path,
          kind: 'weak-test',
          fidelity: Fidelity.Heuristic,
          severity: Severity.LOW,
          evidence:
            'added test asserts nothing (advisory — never blocks the gate)',
          suggestion:
            'add at least one assertion, or delete the test if it is a placeholder.',
          added_ranges: [...unit.added_ranges],
        }),
      );
    }
  }
  return findings;
}

/** Flatten inclusive `[start, end]` ranges into a sorted list of line numbers. */
function linesInRanges(ranges: LineRange[]): number[] {
  const lines = new Set<number>();
  for (const [start, end] of ranges) {
    for (let ln = start; ln <= end; ln++) lines.add(ln);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Return the captured reason iff `line` carries a comment-led annotation.
 *
 * Requires a `//`/`#` comment leader (FIX 1), strips a trailing inline-comment
 * close (e.g. `*​/`), and trims surrounding whitespace.
 */
function suppressionReason(line: string): string | null {
  const match = SUPPRESS_RE.exec(line);
  if (match === null) return null;
  let reason = match[1]!;
  for (const closer of INLINE_COMMENT_CLOSERS) {
    const idx = reason.indexOf(closer);
    if (idx !== -1) reason = reason.slice(0, idx);
  }
  return reason.trim();
}

/**
 * Honor `canary:allow-untested <reason>` annotations (SC-12).
 *
 * Scans the finding's source **only within the unit's added line ranges** for a
 * comment-led `canary:allow-untested <reason>` annotation (both `//` and `#`
 * leaders accepted). A bare occurrence inside a string literal, docstring, or
 * an untouched line therefore never clears the gate (FIX 1). When the finding
 * carries no `added_ranges` the scan falls back to the whole file (still
 * comment-leader gated). Suppressed findings **remain** in the returned list so
 * they stay visible in rendered output — only the hard-gate exit calc ignores
 * them.
 */
export function applySuppressions(
  findings: GuardianFinding[],
  repoRoot = '.',
): GuardianFinding[] {
  for (const finding of findings) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, finding.path), 'utf-8');
    } catch {
      continue;
    }
    const sourceLines = splitLines(source);
    const candidates =
      finding.added_ranges.length > 0
        ? linesInRanges(finding.added_ranges)
        : range1(sourceLines.length);
    for (const lineno of candidates) {
      if (!(lineno >= 1 && lineno <= sourceLines.length)) continue;
      const reason = suppressionReason(sourceLines[lineno - 1]!);
      if (reason !== null) {
        finding.suppressed = true;
        finding.suppression_reason = reason;
        break;
      }
    }
  }
  return findings;
}

/** Python's `range(1, n + 1)` as an array `[1, 2, ..., n]`. */
function range1(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

const HARD_GATE_SEVERITIES = new Set<Severity>([
  Severity.CRITICAL,
  Severity.HIGH,
]);

/**
 * Compute the soft/hard gate exit code (SC-4).
 *
 * - `gate == "soft"` → always `0`.
 * - `gate == "hard"` → `1` iff any finding is an `untested-new-code` finding of
 *   `CRITICAL`/`HIGH` severity that is **not addressed**.
 *
 * A finding is *addressed* when it is suppressed (SC-12) or when a covering
 * test was added in the same diff (in which case it never appears in `findings`
 * at all — suppressed findings do remain, so the live check is simply `not
 * suppressed`).
 *
 * The gate is normalized (`trim().toLowerCase()`) before the comparison so a
 * mistyped `"Hard"` / `" hard "` still enforces rather than silently failing
 * open (FIX 5). Config-load validation ({@link loadGuardianConfig}) is the
 * primary guard against unknown gate values.
 */
export function computeExitCode(
  findings: GuardianFinding[],
  gate: string,
): number {
  const normalizedGate =
    typeof gate === 'string' ? gate.trim().toLowerCase() : gate;
  if (normalizedGate !== 'hard') return 0;
  for (const finding of findings) {
    if (
      finding.kind === 'untested-new-code' &&
      HARD_GATE_SEVERITIES.has(finding.severity) &&
      !finding.suppressed
    ) {
      return 1;
    }
  }
  return 0;
}

const STICKY_MARKER = '<!-- canary-pr-guardian -->';

// Severity → status icon for the sticky comment (encodes severity in form, not
// just text, so the most urgent findings read at a glance).
//
// Written as `\u{...}` escapes, not literal glyphs: this file is `.ts`, and the
// house rule keeps emitted non-ASCII out of non-Markdown source (see the
// "Output data glyphs" block in `cli.ts`). They are emitted verbatim.
/**
 * Character budget for a rendered sticky comment (#457).
 *
 * GitHub rejects an issue/PR comment body over **65,536** characters. The post
 * path reports that as "could not post", so an over-long body means the gate
 * silently produces nothing on exactly the large PRs that need it most -- the
 * same silent-green failure #369 was filed for.
 *
 * 60,000 leaves ~5.5k of headroom for anything appended outside
 * `renderFindings` (degradation annotations, upsert wrappers) without inviting
 * a body that only *just* fits and then breaks when a filename grows.
 *
 * The cap applies ONLY to the comment. The `--emit-analysis` JSON record is the
 * authoritative complete set and is never truncated.
 */
export const COMMENT_CHAR_BUDGET = 60_000;

/** The line that accounts for findings the budget could not fit (#457). */
function overflowNote(omitted: number): string {
  return (
    `<sub>${EM_DASH} and ${omitted} more finding(s) omitted to keep this ` +
    `comment under GitHub's size limit. The full set is in the analysis ` +
    `record (\`--emit-analysis\`) and the CI logs.</sub>`
  );
}

const EM_DASH = '\u{2014}';
const RED_CIRCLE = '\u{1F534}';
const ORANGE_CIRCLE = '\u{1F7E0}';
const YELLOW_CIRCLE = '\u{1F7E1}';
const WHITE_CIRCLE = '\u{26AA}';
const BABY_CHICK = '\u{1F424}';
const ARROW = '\u{2192}';
const WHITE_CHECK = '\u{2705}';
const WARNING = '\u{26A0}\u{FE0F}';

// `CRITICAL` and `HIGH` shared the red circle for as long as `CRITICAL` was
// unreachable (#553) — a collision with nothing to collide with. Now that the
// two are distinguishable, the icon column has to distinguish them, or the
// ranking exists only in the text of a cell nobody scans. Matches
// `summary-emitter.ts`, which has always used the four-color scale.
const SEVERITY_ICON: Record<string, string> = {
  [Severity.CRITICAL]: RED_CIRCLE,
  [Severity.HIGH]: ORANGE_CIRCLE,
  [Severity.MEDIUM]: YELLOW_CIRCLE,
  [Severity.LOW]: WHITE_CIRCLE,
};

/** Serialize a {@link GuardianFinding} to a stable JSON-friendly object. */
function findingDict(finding: GuardianFinding): Record<string, unknown> {
  return {
    path: finding.path,
    unit: finding.unit,
    kind: finding.kind,
    fidelity: finding.fidelity,
    severity: finding.severity,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
    suppressed: finding.suppressed,
    suppression_reason: finding.suppression_reason,
    uncovered_lines: finding.uncovered_lines,
  };
}

/**
 * Render findings as a sticky PR `comment`, `json`, or plain `text`.
 *
 * - `comment`: leads with the sticky marker `<!-- canary-pr-guardian -->`, a
 *   fidelity-labeled summary line, then severity-ranked findings (each showing
 *   path/unit, severity, fidelity, evidence). Suppressed findings are rendered
 *   but visually marked `suppressed`. Footer states `tier 0` and appends
 *   `degradedNotice` when present.
 * - `json`: `{"findings": [...], "tier": <n>}` — stable schema.
 * - `text`: plain, markdown-free, for local/CLI output.
 */
/** Additive gate denominator for the json format (#508). */
/**
 * Where a resolved diff came from (#369). Defined here rather than in `cli.ts`
 * because `DiffProvenance` needs it and `cli.ts` already imports from this
 * module — the reverse edge would be a cycle.
 */
export type DiffOrigin = 'stdin' | 'file' | 'ci-base' | 'worktree';

/**
 * What the scoped diff was actually taken between (#761).
 *
 * Every other number guardian reports is downstream of the diff, so a wrong
 * diff silently rewrites all of them — and the comment previously named only
 * the HEAD side, via the finding permalinks. #761 is the worked
 * example: a PR whose real diff was ONE markdown file was analyzed as 43,
 * because CI diffed the `pull_request` MERGE REF (main merged with the PR head)
 * rather than the PR head. Guardian then reported six files the PR never
 * touched, and nothing on the surface contradicted it.
 *
 * Stating base…head and the file count makes that shape self-evident: a
 * reviewer who knows their PR is one file sees `43 files` and stops reading the
 * findings. This is provenance, not a gate — it changes no exit code.
 */
export interface DiffProvenance {
  /** The rev the diff was taken against; null when the diff was supplied. */
  base: string | null;
  /** The rev the diff was taken to; null when it could not be resolved. */
  head: string | null;
  /** How the diff was obtained. */
  origin: DiffOrigin;
  /** Paths in the scoped diff, BEFORE any skip/test/type-only filtering. */
  fileCount: number;
  /**
   * True when HEAD is a `pull_request` merge ref rather than the PR head — the
   * merge-ref diff defect (#761). Advisory: guardian reports it and carries on, because
   * the caller owns the checkout and only the caller can fix it.
   */
  mergeRef?: boolean;
}

/** Short display form for a rev: 10 chars of a sha, a ref name verbatim. */
function shortRev(rev: string | null): string {
  if (!rev) return '?';
  return /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 10) : rev;
}

/**
 * The one-line diff provenance shown on every surface (#761).
 *
 * Deliberately terse and always present — a line that appears only when
 * something is wrong teaches readers to ignore it when it does appear.
 */
export const MERGE_REF_WARNING =
  'HEAD is a pull_request MERGE REF, not the PR head, so this diff spans ' +
  'commits merged into the base branch and is WIDER than the PR';

export function provenanceLine(p: DiffProvenance): string {
  const noun = p.fileCount === 1 ? 'file' : 'files';
  const range = `${shortRev(p.base)}...${shortRev(p.head)}`;
  const warn = p.mergeRef ? ` ${EM_DASH} ${MERGE_REF_WARNING}` : '';
  return `Diff: \`${range}\` (${p.fileCount} ${noun}, via ${p.origin})${warn}`;
}

export interface GateMeta {
  checked: number;
  abstained: boolean;
  /** The run's coverage-input state, when the coverage ladder ran (#554). */
  coverage?: CoverageInputState | null;
  /** What the diff was taken between (#761). */
  provenance?: DiffProvenance | null;
  /**
   * What this run declined to judge, and why (#582).
   *
   * `checked` alone is honest but incomplete: it cannot distinguish a diff of
   * three source files from a diff of eight where five were filtered out. The
   * abstain payload has carried this since #579; the non-abstain path is the
   * same class one layer down, on a run that did verify a real denominator.
   */
  skipped?: SkipEntry[];
}

/**
 * Join every degradation notice this run produced into one line, dropping the
 * empty ones. Notices are independent (the agent tier and the coverage input
 * degrade for unrelated reasons), so a reader must see both or neither (#554).
 */
export function combineNotices(
  ...notices: Array<string | null | undefined>
): string | null {
  const kept = notices.filter((n): n is string => Boolean(n));
  return kept.length > 0 ? kept.join('; ') : null;
}

/** The `coverage` block the json/analysis surfaces carry (#554). */
function coverageBlock(state: CoverageInputState): Record<string, unknown> {
  return { status: coverageStatus(state), ...state };
}

/**
 * True when this run VERIFIED NO COVERAGE and every finding it produced is a
 * naming-heuristic guess (#761) — an abstention, not a result.
 *
 * Guardian's existing abstention keys off the *findings-eligible* count, which
 * is the wrong denominator: a run can have plenty of eligible units and still
 * have verified nothing, because "findings-eligible" and "coverage-verifiable"
 * are different counts. The measured shape is a code PR whose lcov never
 * reached the runner: N eligible units, zero coverage denominator, and a
 * confident "6 files need test coverage" headline under a green check.
 *
 * Two narrowings keep this honest rather than merely loud:
 *
 *   - `unitsTotal === 0` is NOT this case. A run that judged nothing makes no
 *     coverage claim in either direction; the eligible-count abstention owns it,
 *     the same boundary {@link coverageDegradedNotice} already draws.
 *   - A single coverage- or graph-verified finding disproves it. Real evidence
 *     means the run measured something, so it is a result and must not be
 *     downgraded to an abstention.
 *   - A run with NO findings is left alone. It states nothing a reader can
 *     mistake for a measurement: #554 already replaced its all-clear headline
 *     with "no gaps found, but coverage was unavailable" plus the body line
 *     saying that is an abstention, not a pass. The defect #761 reports is
 *     specifically a CONFIDENT COUNT over a zero coverage denominator, so that
 *     is what changes here.
 */
export function isCoverageAbstention(
  coverage: CoverageInputState | null | undefined,
  findings: GuardianFinding[],
): boolean {
  if (!coverage || coverage.unitsTotal === 0) return false;
  if (coverageStatus(coverage) !== 'unavailable') return false;
  if (findings.length === 0) return false;
  return findings.every((f) => f.fidelity === Fidelity.Heuristic);
}

/**
 * The abstention headline (#761) — states what was NOT verified, and never a
 * count of findings, which is what reads as a measured result.
 */
function abstentionHeadline(checked: number): string {
  const noun = checked === 1 ? 'file' : 'files';
  return (
    `${WARNING} abstained: no coverage data ` +
    `(${checked} ${noun} judged heuristically)`
  );
}

/** The body paragraph that stops the heuristic findings reading as a verdict. */
const ABSTENTION_BODY =
  'No coverage report reached this run, so nothing below is a coverage ' +
  'verdict — every finding is a filename-level guess. A gate that verified ' +
  'zero items has abstained; this is not a pass.';

/**
 * The comment body for a run with zero active findings.
 *
 * #554: the ✅ all-clear headline is reserved for a run whose coverage report
 * spoke to every changed file. Anything less says so in the body — a `<sub>`
 * footer under a green headline is read as boilerplate, and this is the exact
 * shape that let 43 coverage-blind PRs read as covered.
 */
function noGapsLines(
  coverageState: CoverageInputState | null,
  suppressedCount: number,
  abstained = false,
  checked = 0,
): string[] {
  const notice = coverageState ? coverageDegradedNotice(coverageState) : null;
  const headline = abstained
    ? abstentionHeadline(checked)
    : notice
      ? `${WARNING} no gaps found, but coverage was ${coverageStatus(coverageState!)}`
      : `${WHITE_CHECK} no test-coverage gaps`;
  const lines = [`## ${BABY_CHICK} Canary PR Guardian ${EM_DASH} ${headline}`];
  if (notice) {
    lines.push(
      `> **${notice}**`,
      '',
      'Zero files matched is an abstention, not a pass — nothing here is ' +
        'evidence that the changed lines are covered.',
    );
  }
  if (suppressedCount) {
    lines.push(`_${suppressedCount} finding(s) suppressed as intentional._`);
  }
  return lines;
}

export function renderFindings(
  findings: GuardianFinding[],
  fmt: string,
  tier = 0,
  degradedNotice: string | null = null,
  gateMeta: GateMeta | null = null,
  blobBase: string | null = null,
): string {
  const ordered = [...findings].sort(
    (a, b) => severitySortKey(a.severity) - severitySortKey(b.severity),
  );

  // #761: an abstained run never headlines a count, on any surface.
  const abstained = gateMeta?.abstained === true;
  // #554: the coverage ladder's own degradation, stated alongside the tier's.
  const coverageState = gateMeta?.coverage ?? null;
  const coverageNotice = coverageState
    ? coverageDegradedNotice(coverageState)
    : null;
  const notice = combineNotices(degradedNotice, coverageNotice);

  if (fmt === 'json') {
    const payload: Record<string, unknown> = {
      findings: ordered.map(findingDict),
      tier,
    };
    if (notice) payload['degraded_notice'] = notice;
    if (gateMeta !== null) {
      payload['checked'] = gateMeta.checked;
      payload['abstained'] = gateMeta.abstained;
      // #582: unconditional, and `[]` when nothing was dropped. An omitted key
      // would make "this run skipped nothing" indistinguishable from "this
      // producer predates #582", leaving a consumer to guess exactly the thing
      // the field exists to state.
      payload['skipped'] = gateMeta.skipped ?? [];
      if (coverageState) payload['coverage'] = coverageBlock(coverageState);
      // #761: machine consumers need the diff's endpoints for the same reason
      // humans do — every count in this payload is scoped by them.
      if (gateMeta.provenance)
        payload['provenance'] = { ...gateMeta.provenance };
    }
    return ensureAscii(JSON.stringify(payload, null, 2));
  }

  const active = ordered.filter((f) => !f.suppressed);
  const suppressed = ordered.filter((f) => f.suppressed);

  const cell = (s: string): string => s.replace(/\|/g, '\\|');

  // The line range a permalink should open at: the first range the coverage run
  // proved unhit, else the first range the diff added. Empty when neither is
  // known, so the link degrades to the file rather than to a wrong line.
  const linkAnchor = (f: GuardianFinding): string => {
    const ranges = f.uncovered_lines.length
      ? mergeLines(f.uncovered_lines)
      : f.added_ranges;
    const first = ranges[0];
    if (!first) return '';
    return first[0] === first[1]
      ? `#L${first[0]}`
      : `#L${first[0]}-L${first[1]}`;
  };

  // A finding's file label shows the path once, appending the unit only when
  // it is a distinct symbol within the file (never `path (path)`). The path
  // becomes a permalink when a blob base is resolvable; with no base it stays
  // plain code text, because a dead link reads as actionable and is not.
  // Parentheses must be percent-encoded inside a markdown link target: a bare
  // `)` closes the link early, so a Next.js route group (`app/(marketing)/…`)
  // or any parenthesized directory would render as broken markup.
  const urlPath = (path: string): string =>
    path.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const fileLabel = (f: GuardianFinding): string => {
    const shown = `\`${f.path}\``;
    const linked = blobBase
      ? `[${shown}](${blobBase}/${urlPath(f.path)}${linkAnchor(f)})`
      : shown;
    return f.unit && f.unit !== f.path ? `${linked} → \`${f.unit}\`` : linked;
  };

  // Evidence, then the suggested action on its own line. The specific uncovered
  // lines live in the suggestion rather than in a second parenthetical, so the
  // list is stated exactly once. A finding with no suggestion (a hand-built or
  // pre-existing record) renders evidence alone — never a dangling arrow.
  const whatCell = (f: GuardianFinding): string => {
    const action = f.suggestion
      ? `<br><sub>${ARROW} ${cell(f.suggestion)}</sub>`
      : '';
    return `${cell(f.evidence)}${action}`;
  };
  const CONFIDENCE_NOTE =
    'Confidence — **coverage-verified**: measured from a real coverage run · ' +
    '**graph-verified**: inferred from the call graph · **heuristic**: filename ' +
    `guess (lowest). tier ${tier}: deterministic check, no LLM.`;

  const footerLine = `<sub>${CONFIDENCE_NOTE}${notice ? ` ${EM_DASH} ${notice}` : ''}</sub>`;

  // #554: a coverage-blind run must not present as a run that checked and found
  // nothing. The notice goes in the BODY, not only the footer — a `<sub>` line
  // under a green headline is read as boilerplate.
  const coverageLine = coverageNotice ? `> **${coverageNotice}**` : null;

  // #761: shown on EVERY comment, clean or not. The run that motivated this was
  // a findings run whose findings were all phantom, so gating the line on a
  // problem guardian had not detected would have hidden it exactly when needed.
  const provLine = gateMeta?.provenance
    ? `<sub>${provenanceLine(gateMeta.provenance)}</sub>`
    : null;

  if (fmt === 'comment') {
    const fileCount = new Set(active.map((f) => f.path)).size;
    const lines = [STICKY_MARKER];

    if (active.length === 0) {
      lines.push(
        ...noGapsLines(
          coverageState,
          suppressed.length,
          abstained,
          gateMeta?.checked ?? 0,
        ),
      );
    } else {
      const noun = fileCount === 1 ? 'file needs' : 'files need';
      // #761: on an abstained run the headline states the abstention instead of
      // a count. The findings stay in the table below — they are useful, they
      // are just not a coverage verdict, and a count headline is exactly what
      // makes a reader take them for one.
      lines.push(
        `## ${BABY_CHICK} Canary PR Guardian ${EM_DASH} ` +
          (abstained
            ? abstentionHeadline(gateMeta?.checked ?? 0)
            : `${fileCount} ${noun} test coverage`),
      );
      lines.push(
        abstained
          ? ABSTENTION_BODY
          : 'These lines were changed by this PR but no test exercises them. Add or ' +
              'extend a test that covers them, or mark the line ' +
              '`// canary:allow-untested <reason>` if it is intentionally untested.',
      );
      if (coverageLine) lines.push('', coverageLine);
      lines.push(
        '',
        '| Sev | File | What is uncovered, and what to do | Confidence |',
        '| --- | --- | --- | --- |',
      );
      // #457: fill rows against a character budget instead of emitting all of
      // them. `active` is already severity-ordered, so the rows that survive
      // are the most severe -- a critical finding is never dropped to make room
      // for a low one.
      const suppressedNote = suppressed.length
        ? `\n\n<sub>${suppressed.length} finding(s) suppressed as intentional and not counted above.</sub>`
        : '';
      // Reserved so the tail always fits: footer, suppressed note, and a
      // worst-case overflow line (the real one is shorter).
      const reserve =
        footerLine.length +
        suppressedNote.length +
        overflowNote(active.length).length +
        4;

      let used = lines.join('\n').length;
      let shown = 0;
      for (const f of active) {
        const row = `| ${SEVERITY_ICON[f.severity] ?? ''} ${f.severity} | ${cell(fileLabel(f))} | ${whatCell(f)} | ${f.fidelity} |`;
        if (used + row.length + 1 + reserve > COMMENT_CHAR_BUDGET) break;
        lines.push(row);
        used += row.length + 1;
        shown += 1;
      }

      const omitted = active.length - shown;
      if (omitted > 0) lines.push('', overflowNote(omitted));

      if (suppressed.length) {
        lines.push(
          '',
          `<sub>${suppressed.length} finding(s) suppressed as intentional and not counted above.</sub>`,
        );
      }
    }

    // Directly above the confidence footer: provenance and confidence are the
    // two "how much should I trust this" facts, so they read as one block.
    if (provLine) lines.push('', provLine);
    lines.push('', footerLine);
    return lines.join('\n');
  }

  // fmt == "text" (default fallback): plain, no markdown/HTML.
  const cleanHeadline = coverageNotice
    ? // #554: same rule as the comment surface — a blind run never claims clean.
      `Canary PR Guardian — no gaps found, but coverage was ${coverageStatus(coverageState!)}`
    : 'Canary PR Guardian — no test-coverage gaps';
  // #761: the same rule on the surface an engineer reads at their desk. The
  // headline is stripped of the comment surface's markdown-era glyph so the
  // terminal line stays plain text.
  const textAbstention =
    `Canary PR Guardian — ` +
    abstentionHeadline(gateMeta?.checked ?? 0).replace(`${WARNING} `, '');
  const lines = [
    abstained
      ? textAbstention
      : active.length === 0
        ? cleanHeadline
        : `Canary PR Guardian — ${new Set(active.map((f) => f.path)).size} file(s) need test coverage`,
  ];
  for (const finding of ordered) {
    const unit =
      finding.unit && finding.unit !== finding.path ? ` → ${finding.unit}` : '';
    const mark = finding.suppressed ? ' (suppressed)' : '';
    lines.push(
      `[${finding.severity}] ${finding.path}${unit} — ${finding.evidence} (${finding.fidelity})${mark}`,
    );
  }
  // #761: the terminal surface gets the same provenance the comment does —
  // this is the one an engineer reads at their desk, where a wrong `--diff` is
  // likeliest.
  if (gateMeta?.provenance) {
    lines.push(provenanceLine(gateMeta.provenance).replace(/`/g, ''));
  }
  let footer = `tier ${tier}: deterministic check, no LLM`;
  if (notice) footer += ` - ${notice}`;
  lines.push(footer);
  return lines.join('\n');
}

// SC-2 canonical skip set: files no coverage gate should ever fire on. Docs and
// markdown never need a covering test; generated/dependency artifacts
// (lockfiles, built bundles under dist/build, minified JS, test snapshots) are
// not authored code and would only produce noise. This is the DEFAULT skip set
// when a config omits `skipGlobs` entirely — an explicit `skipGlobs` (even `[]`)
// overrides it. See {@link loadGuardianConfig}.
export const DEFAULT_SKIP_GLOBS: readonly string[] = [
  'docs/**',
  '**/*.md',
  // Dependency lockfiles (generated, never hand-tested).
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/*.lock',
  // Build outputs and generated bundles/snapshots.
  'dist/**',
  'build/**',
  '**/*.min.js',
  '**/*.snap',
  // Generated slash-command artifacts and harness state — regenerated from a
  // tracked source (skill.yaml / graph scans), never hand-authored, so a
  // covering test makes no sense. `**/.harness/**` also catches harness state
  // nested under a subproject (e.g. `services/neo/.harness/…`), which the
  // top-level `.harness/**` misses (#413).
  'agents/commands/**',
  '.harness/**',
  '**/.harness/**',
  // Dotfile config/metadata at any depth (.gitignore, .env, .eslintrc,
  // .neorc*, .dockerignore, .npmrc, …). None carry testable code, so the
  // heuristic tier's "no test file references this" is a false positive on them
  // (#413 — observed on `.gitignore` / `.neorc.dev`). Matches only files whose
  // basename starts with a dot, not source inside a dot-directory.
  '**/.*',
  // Build/tooling config files (not authored product logic).
  '**/*.config.js',
  '**/*.config.ts',
  '**/*.config.mjs',
  '**/*.config.cjs',
  // Test fixtures / mocks and generated code — noise, not logic under test.
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/testdata/**',
  '**/generated/**',
  '**/__generated__/**',
];

/**
 * Parsed `canary.guardian` config block.
 *
 * Phase 1 stores every field but only `pr_*` gate/tier drive behavior.
 * `skip_globs` and the `precommit_*`/`coverage_paths` fields are read into the
 * object (scaffold) for later phases (SC-2 skip, SC-5 tier).
 *
 * `skip_globs` defaults to docs/markdown PLUS generated/dependency artifacts
 * (lockfiles, `dist`/`build` outputs, minified JS, snapshots — see
 * {@link DEFAULT_SKIP_GLOBS}) so noise-only paths skip out of the box; an
 * explicit `skipGlobs` in config (even `[]`) overrides it.
 */
export class GuardianConfig {
  pr_enabled: boolean;
  pr_tier: number;
  pr_gate: string;
  // Emit advisory `weak-test` findings for added tests that assert nothing.
  // Non-gating always; default on (it only surfaces a comment, never blocks).
  weak_tests: boolean;
  precommit_enabled: boolean;
  precommit_author_tests: boolean;
  precommit_gate: string;
  coverage_paths: string[];
  skip_globs: string[];
  // #413: glob layer suppressing the HEURISTIC tier only (a source path that
  // still has nothing a naming heuristic can judge). Distinct from
  // `skip_globs`, which drops a path from the gate entirely at every tier.
  heuristic_exclude: string[];
  // #320: bound the graph-coverage reverse-BFS. `null` means "gate-derived"
  // (see {@link effectiveGraphDepth} — hard→1 direct edge, soft→unbounded); an
  // explicit int here overrides the gate default on BOTH surfaces.
  graph_coverage_max_depth: number | null;

  constructor(init: Partial<GuardianConfigFields> = {}) {
    this.pr_enabled = init.pr_enabled ?? true;
    this.pr_tier = init.pr_tier ?? 0;
    this.pr_gate = init.pr_gate ?? 'soft';
    this.weak_tests = init.weak_tests ?? true;
    this.precommit_enabled = init.precommit_enabled ?? false;
    this.precommit_author_tests = init.precommit_author_tests ?? false;
    this.precommit_gate = init.precommit_gate ?? 'soft';
    this.coverage_paths = init.coverage_paths ?? [];
    this.skip_globs = init.skip_globs ?? [...DEFAULT_SKIP_GLOBS];
    this.heuristic_exclude = init.heuristic_exclude ?? [
      ...DEFAULT_HEURISTIC_EXCLUDE_GLOBS,
    ];
    this.graph_coverage_max_depth = init.graph_coverage_max_depth ?? null;
  }
}

interface GuardianConfigFields {
  pr_enabled: boolean;
  pr_tier: number;
  pr_gate: string;
  weak_tests: boolean;
  precommit_enabled: boolean;
  precommit_author_tests: boolean;
  precommit_gate: string;
  coverage_paths: string[];
  skip_globs: string[];
  heuristic_exclude: string[];
  graph_coverage_max_depth: number | null;
}

const VALID_GATES = new Set(['soft', 'hard']);

/** Rough analog of Python's `repr()` for a diagnostic value. */
function pyRepr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    // Python dict repr: `{'k': 'v'}` (keys and values repr'd, comma-space).
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

/**
 * Parse an integer the way Python's `int(str(raw).strip())` does: optional
 * surrounding whitespace and sign, digits only. Returns `null` on failure
 * (Python would raise `ValueError`, which the coercers catch-and-default).
 */
function pyIntFromValue(raw: unknown): number | null {
  const s =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * Coerce a config `tier` to an int, warning + defaulting on bad input.
 *
 * A plain int is taken as-is; a clean integer string (`"2"`) is accepted;
 * anything else (`"medium"`, `1.5`, `[]`, `true`) warns and defaults — never
 * raises (FIX 4, SC-8).
 */
function coerceTier(raw: unknown, def: number, warnings: string[]): number {
  if (typeof raw === 'boolean') {
    warnings.push(
      `guardian pr.tier must be an integer, got ${pyRepr(raw)}; using ${def}`,
    );
    return def;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const parsed = pyIntFromValue(raw);
  if (parsed === null) {
    warnings.push(
      `guardian pr.tier must be an integer, got ${pyRepr(raw)}; using ${def}`,
    );
    return def;
  }
  return parsed;
}

/**
 * Coerce a config value to `number | null`, warning + defaulting `null`.
 *
 * A plain int (not `boolean`) is taken as-is; a clean integer string (`"2"`) is
 * accepted; anything else (a float, `"x"`, `[]`, `true`) warns and defaults to
 * `null` (unbounded) — never raises (#320, SC-8).
 *
 * When `minValue` is given, a parsed int BELOW it is treated as a bad value:
 * warn loudly and fall back to `null` (FIX 2, #320).
 */
function coerceOptionalInt(
  raw: unknown,
  fieldName: string,
  warnings: string[],
  minValue: number | null = null,
): number | null {
  let parsed: number | null;
  if (typeof raw === 'boolean') {
    parsed = null;
  } else if (typeof raw === 'number' && Number.isInteger(raw)) {
    parsed = raw;
  } else {
    parsed = pyIntFromValue(raw);
  }
  if (parsed === null) {
    warnings.push(
      `guardian ${fieldName} must be an integer, got ${pyRepr(raw)}; ignoring`,
    );
    return null;
  }
  if (minValue !== null && parsed < minValue) {
    warnings.push(
      `guardian ${fieldName} must be >= ${minValue}; ignoring ${parsed}, ` +
        `using unbounded`,
    );
    return null;
  }
  return parsed;
}

/**
 * Validate a config gate against `{soft, hard}`, warning + defaulting.
 *
 * Normalizes case/whitespace; anything outside the set warns and defaults (FIX
 * 4/FIX 5 — an unknown gate must never silently disable enforcement).
 *
 * Only a string or number is stringified; a non-scalar (array/object) warns and
 * defaults rather than being flattened. `String(["hard"])` is `"hard"`, which
 * would wrongly ENFORCE, whereas Python's `str(["hard"])` is `"['hard']"` and is
 * rejected — this guard keeps the two in lockstep.
 */
function coerceGate(
  raw: unknown,
  def: string,
  fieldName: string,
  warnings: string[],
): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    warnings.push(
      `guardian ${fieldName} must be 'soft' or 'hard', got ${pyRepr(raw)}; ` +
        `using ${def}`,
    );
    return def;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (VALID_GATES.has(normalized)) return normalized;
  warnings.push(
    `guardian ${fieldName} must be 'soft' or 'hard', got ${pyRepr(raw)}; ` +
      `using ${def}`,
  );
  return def;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Python-truthiness for JSON-shaped values: `null`/`undefined`, `false`, `0`,
 * `""`, empty array, and empty object are all falsy (mirrors `bool(x)`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `dict.get(key, default)`: default only on a missing key. */
function pyGet(
  obj: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Load the `canary.guardian` block, distinguishing absent from malformed.
 *
 * Uses {@link readJsonWithWarning}. Returns `[GuardianConfig, warning]`:
 *
 *   - file absent                     → `[defaults, null]`  (silent, normal)
 *   - malformed JSON                  → `[defaults, "<warn>"]` (LOUD, SC-8)
 *   - valid but no `canary.guardian`  → `[defaults, null]`
 *   - valid `canary.guardian`         → `[parsed, null]`
 *   - valid block, bad `tier`/`gate`  → `[defaults for those fields, "<warn>"]`
 *     — coercion never raises and the warning rides the same loud slot the CLI
 *     echoes (FIX 4).
 */
export function loadGuardianConfig(
  configPath = 'harness.config.json',
): [GuardianConfig, string | null] {
  const [data, warning] = readJsonWithWarning(configPath);
  if (warning !== null || !isRecord(data)) {
    return [new GuardianConfig(), warning];
  }

  const canary = pyGet(data, 'canary', {});
  const block: unknown = isRecord(canary) ? pyGet(canary, 'guardian', {}) : {};
  if (!isRecord(block) || Object.keys(block).length === 0) {
    return [new GuardianConfig(), null];
  }

  const config = new GuardianConfig();
  const warnings: string[] = [];

  const pr = pyGet(block, 'pr', {});
  if (isRecord(pr)) {
    config.pr_enabled = pyTruthy(pyGet(pr, 'enabled', config.pr_enabled));
    if ('tier' in pr) {
      config.pr_tier = coerceTier(pr['tier'], config.pr_tier, warnings);
    }
    if ('gate' in pr) {
      config.pr_gate = coerceGate(
        pr['gate'],
        config.pr_gate,
        'pr.gate',
        warnings,
      );
    }
    config.weak_tests = pyTruthy(pyGet(pr, 'weakTests', config.weak_tests));
    // #413: same present-vs-absent contract as `skipGlobs` (FIX B) — absent
    // keeps the built-in default, an explicit list (including `[]`) is honored
    // verbatim so `heuristicExclude: []` means "no glob layer". The
    // {@link isSourcePath} extension floor is unaffected either way.
    const heuristicExclude = pr['heuristicExclude'];
    if (Array.isArray(heuristicExclude)) {
      config.heuristic_exclude = heuristicExclude.map((g) => String(g));
    }
  }

  const precommit = pyGet(block, 'preCommit', {});
  if (isRecord(precommit)) {
    config.precommit_enabled = pyTruthy(
      pyGet(precommit, 'enabled', config.precommit_enabled),
    );
    config.precommit_author_tests = pyTruthy(
      pyGet(precommit, 'authorTests', config.precommit_author_tests),
    );
    if ('gate' in precommit) {
      config.precommit_gate = coerceGate(
        precommit['gate'],
        config.precommit_gate,
        'preCommit.gate',
        warnings,
      );
    }
  }

  const coveragePaths = block['coveragePaths'];
  if (Array.isArray(coveragePaths)) {
    config.coverage_paths = coveragePaths.map((p) => String(p));
  }

  // #320: an explicit graphCoverageMaxDepth overrides the gate-derived default
  // on both surfaces. A bad value warns loudly (SC-8) and stays null.
  if ('graphCoverageMaxDepth' in block) {
    config.graph_coverage_max_depth = coerceOptionalInt(
      block['graphCoverageMaxDepth'],
      'graphCoverageMaxDepth',
      warnings,
      1,
    );
  }

  // FIX B: only override the default (docs/** + **/*.md + generated) when
  // skipGlobs is PRESENT. Absent → keep the default; an explicit list
  // (including empty []) is honored verbatim so a deliberate `skipGlobs: []`
  // means "skip nothing".
  const skipGlobs = block['skipGlobs'];
  if (Array.isArray(skipGlobs)) {
    config.skip_globs = skipGlobs.map((g) => String(g));
  }

  return [config, warnings.length > 0 ? warnings.join('; ') : null];
}

/**
 * Resolve the graph-coverage BFS depth for a given `gate` (#320).
 *
 * An explicit `config.graph_coverage_max_depth` always wins (the operator opted
 * in). Otherwise the depth is DERIVED from the gate: a `hard` gate requires a
 * DIRECT test→source edge (depth `1`), while a `soft` gate stays unbounded
 * (`null`) — byte-for-byte the current soft-default behavior. The gate is
 * normalized (`trim().toLowerCase()`) so a mistyped `"Hard"` still bounds.
 * Shared by the CLI (`pr-check`/`author-plan`) and the pre-commit hook.
 */
export function effectiveGraphDepth(
  config: GuardianConfig,
  gate: string,
): number | null {
  if (config.graph_coverage_max_depth !== null) {
    return config.graph_coverage_max_depth;
  }
  const normalized =
    typeof gate === 'string' ? gate.trim().toLowerCase() : gate;
  return normalized === 'hard' ? 1 : null;
}
