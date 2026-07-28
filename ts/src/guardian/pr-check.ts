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
import { isAssertionFreeTest } from '../core/quality-scorer.js';
import {
  ChangedUnit,
  CoverageResult,
  Fidelity,
  LineRange,
  isTestPath,
} from './coverage.js';
import { Severity, severitySortKey } from './impact-mapper.js';

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
 * A single guardian finding about a changed unit.
 *
 * Phase 1 emits only `untested-new-code` findings (`weak-test` is a Tier 1+
 * concern). `severity` reuses {@link Severity}; `fidelity` carries the
 * confidence tier from the underlying coverage signal.
 */
export class Finding {
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
  }
}

/**
 * Turn uncovered coverage results into fidelity-labeled findings.
 *
 * Only **uncovered** results become findings. Severity policy (Phase 1):
 *
 *   - `COVERAGE_VERIFIED` uncovered → `HIGH`
 *   - `GRAPH_VERIFIED` uncovered    → `HIGH`
 *   - `HEURISTIC` uncovered         → `MEDIUM` (lower confidence)
 *
 * Results are sorted by severity sort-key (critical → low).
 */
export function buildFindings(results: CoverageResult[]): Finding[] {
  const findings: Finding[] = [];
  for (const result of results) {
    if (result.covered) continue;
    const severity =
      result.fidelity === Fidelity.Heuristic ? Severity.MEDIUM : Severity.HIGH;
    const unit = result.unit;
    findings.push(
      new Finding({
        path: unit.path,
        unit: unit.symbol || unit.path,
        fidelity: result.fidelity,
        severity,
        evidence: result.evidence,
        added_ranges: [...unit.added_ranges],
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
 * Advisory `weak-test` findings for ADDED tests that assert nothing.
 *
 * Consumes the test-path units {@link filterTestUnits} sets aside (a test file
 * needs no test of its own, but an added test that asserts nothing is itself a
 * gap). Scores only the diff's *added* lines per test file via
 * {@link isAssertionFreeTest} — a high-precision signal (a real test function
 * with zero assertions), so snapshot/table-driven tests are not flagged. These
 * findings are `LOW`/`weak-test` and are **never** gated (see
 * {@link computeExitCode}): they surface, never block.
 */
export function buildWeakTestFindings(
  testUnits: ChangedUnit[],
  diffText: string,
): Finding[] {
  const addedByPath = addedContentByPath(diffText);
  const findings: Finding[] = [];
  for (const unit of testUnits) {
    const added = addedByPath.get(unit.path);
    if (!added || added.length === 0) continue;
    // A rename adds only the signature line (body is unchanged context) —
    // nothing new to judge, so don't flag it (FP guard).
    if (!hasAddedTestBody(added)) continue;
    const code = added.join('\n');
    const framework = frameworkForTestPath(unit.path);
    if (isAssertionFreeTest(code, framework)) {
      findings.push(
        new Finding({
          path: unit.path,
          unit: unit.path,
          kind: 'weak-test',
          fidelity: Fidelity.Heuristic,
          severity: Severity.LOW,
          evidence:
            'added test asserts nothing (advisory — never blocks the gate)',
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
  findings: Finding[],
  repoRoot = '.',
): Finding[] {
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
export function computeExitCode(findings: Finding[], gate: string): number {
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
const SEVERITY_ICON: Record<string, string> = {
  [Severity.CRITICAL]: '🔴',
  [Severity.HIGH]: '🔴',
  [Severity.MEDIUM]: '🟡',
  [Severity.LOW]: '⚪',
};

/**
 * Escape every non-ASCII (>= U+0080) code unit to a `\uXXXX` sequence, matching
 * Python's `json.dumps(..., ensure_ascii=True)` (the library default). `JSON`
 * `.stringify` emits raw UTF-8 for these, so a finding whose evidence carries an
 * em-dash (`—`, U+2014) would otherwise diverge byte-for-byte from the Python
 * oracle. Only touches the >= 0x80 range, so the ASCII escapes JSON.stringify
 * already produced (`\"`, `\\`, control chars) are left intact.
 */
function ensureAscii(json: string): string {
  return json.replace(
    /[-￿]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/** Serialize a {@link Finding} to a stable JSON-friendly object. */
function findingDict(finding: Finding): Record<string, unknown> {
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
export function render(
  findings: Finding[],
  fmt: string,
  tier = 0,
  degradedNotice: string | null = null,
): string {
  const ordered = [...findings].sort(
    (a, b) => severitySortKey(a.severity) - severitySortKey(b.severity),
  );

  if (fmt === 'json') {
    const payload: Record<string, unknown> = {
      findings: ordered.map(findingDict),
      tier,
    };
    if (degradedNotice) payload['degraded_notice'] = degradedNotice;
    return ensureAscii(JSON.stringify(payload, null, 2));
  }

  const active = ordered.filter((f) => !f.suppressed);
  const suppressed = ordered.filter((f) => f.suppressed);

  // A finding's file label shows the path once, appending the unit only when
  // it is a distinct symbol within the file (never `path (path)`).
  const fileLabel = (f: Finding): string =>
    f.unit && f.unit !== f.path
      ? `\`${f.path}\` → \`${f.unit}\``
      : `\`${f.path}\``;
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const CONFIDENCE_NOTE =
    'Confidence — **coverage-verified**: measured from a real coverage run · ' +
    '**graph-verified**: inferred from the call graph · **heuristic**: filename ' +
    `guess (lowest). tier ${tier}: deterministic check, no LLM.`;

  if (fmt === 'comment') {
    const fileCount = new Set(active.map((f) => f.path)).size;
    const lines = [STICKY_MARKER];

    if (active.length === 0) {
      lines.push('## 🐤 Canary PR Guardian — ✅ no test-coverage gaps');
      if (suppressed.length) {
        lines.push(
          `_${suppressed.length} finding(s) suppressed as intentional._`,
        );
      }
    } else {
      const noun = fileCount === 1 ? 'file needs' : 'files need';
      lines.push(
        `## 🐤 Canary PR Guardian — ${fileCount} ${noun} test coverage`,
      );
      lines.push(
        'These lines were changed by this PR but no test exercises them. Add or ' +
          'extend a test that covers them, or reply ' +
          '`/guardian suppress <file> <reason>` if they are intentionally untested.',
      );
      lines.push(
        '',
        '| Sev | File | What’s uncovered | Confidence |',
        '| --- | --- | --- | --- |',
      );
      for (const f of active) {
        lines.push(
          `| ${SEVERITY_ICON[f.severity] ?? ''} ${f.severity} | ${cell(fileLabel(f))} | ${cell(f.evidence)} | ${f.fidelity} |`,
        );
      }
      if (suppressed.length) {
        lines.push(
          '',
          `<sub>${suppressed.length} finding(s) suppressed as intentional and not counted above.</sub>`,
        );
      }
    }

    lines.push(
      '',
      `<sub>${CONFIDENCE_NOTE}${degradedNotice ? ` — ${degradedNotice}` : ''}</sub>`,
    );
    return lines.join('\n');
  }

  // fmt == "text" (default fallback): plain, no markdown/HTML.
  const lines = [
    active.length === 0
      ? 'Canary PR Guardian — no test-coverage gaps'
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
  let footer = `tier ${tier}: deterministic check, no LLM`;
  if (degradedNotice) footer += ` - ${degradedNotice}`;
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
