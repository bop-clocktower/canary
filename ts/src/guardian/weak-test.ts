/**
 * The advisory `weak-test` finding: an ADDED test that asserts nothing (#747).
 *
 * Split out of `pr-check.ts` because it is a self-contained judgement with its
 * own vocabulary — test declarations, block spans, assertion presence — and
 * because resolving an enclosing block from a diff is a good deal of machinery
 * to keep inline. The dependency runs one way (this module reads `pr-check`;
 * `pr-check` never reads this), so the `pr-check` -> weak-test edge that would
 * make a cycle does not exist: `guardian/cli.ts` is what calls into here.
 */

import { extname } from 'node:path';

import { Fidelity, type ChangedUnit } from './coverage.js';
import { Severity } from './impact-mapper.js';
import {
  GuardianFinding,
  addedContentByPath,
  linesInRanges,
  walkDiff,
} from './pr-check.js';
import { isAssertionFreeTest } from '../core/quality-scorer.js';

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

function visibleLinesByPath(diffText: string): Map<string, VisibleFile> {
  const files = new Map<string, VisibleFile>();
  walkDiff(diffText, (line) => {
    let file = files.get(line.path);
    if (!file) {
      file = { text: new Map(), added: new Set() };
      files.set(line.path, file);
    }
    file.text.set(line.lineno, line.text);
    if (line.added) file.added.add(line.lineno);
  });
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
