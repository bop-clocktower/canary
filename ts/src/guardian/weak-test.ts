/**
 * The advisory `weak-test` finding: an ADDED test that asserts nothing (#747).
 *
 * Split out of `pr-check.ts` as a self-contained judgement — test declarations,
 * block spans, assertion presence. The dependency runs one way (this module
 * reads `pr-check`, never the reverse); `guardian/cli.ts` calls into here.
 */

import { readFileSync } from 'node:fs';

import { Fidelity, type ChangedUnit } from './coverage.js';
import { Severity } from './impact-mapper.js';
import {
  GuardianFinding,
  addedContentByPath,
  linesInRanges,
  walkDiff,
} from './pr-check.js';
import { hasAssertion, isAssertionFreeTest } from '../core/quality-scorer.js';

// Test-file extension -> the quality scorer's framework. Unknown -> pytest.
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
  const ext = /\.[^./\\]+$/.exec(path)?.[0] ?? '';
  return TEST_FRAMEWORK_BY_EXT[ext.toLowerCase()] ?? 'pytest';
}

// A signature / decorator / block-close / comment — not a test *body*. A rename
// that adds only `def test_new():` over an unchanged body has nothing to judge.
const TEST_SIGNATURE_RE =
  /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*(?:it|test|describe)\s*\(/;

const BLOCK_DELIMITERS = new Set(['})', '});', '}', ')', '{']);

const NON_BODY_PREFIXES = ['#', '//', '@', '*', '/*'];

/** True iff `added` holds a real body line, not just signature/comment/brace. */
function hasAddedTestBody(added: string[]): boolean {
  return added.some((line) => {
    const stripped = line.trim();
    if (!stripped || BLOCK_DELIMITERS.has(stripped)) return false;
    if (NON_BODY_PREFIXES.some((p) => stripped.startsWith(p))) return false;
    return !TEST_SIGNATURE_RE.test(line);
  });
}

// The declaration of a single test. Narrower than TEST_SIGNATURE_RE on purpose:
// `describe(` opens a group, and judging a whole group would let an asserting
// sibling excuse an empty test. `it.only` / `test.each` still open one test.
const TEST_DECL_PY = /^\s*(?:async\s+)?def\s+test\w*\s*\(/;
const TEST_DECL_JS = /^\s*(?:async\s+)?(?:it|test)(?:\.\w+)*\s*\(/;

// A same-file helper definition (#929): `function f(`, `const f = (` / `=
// function` / `= x =>`, or Python `def f(`.
const HELPER_DEF_PY = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/;
const HELPER_DEF_JS =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\(|\w+\s*=>))/;

type LineRange = [number, number];

const TEST_TITLE_RE = /\(\s*(['"`])((?:\\.|(?!\1).)*)\1|def\s+(\w+)/;

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

// Strings and comments are blanked before delimiter counting.
const JS_STRING_OR_COMMENT =
  /(['"`])(?:\\.|(?!\1).)*?\1|\/\/.*$|\/\*[\s\S]*?\*\//g;

/** New-side lines, the ADDED line numbers, and `eof` when the whole file is known. */
interface VisibleFile {
  text: Map<number, string>;
  added: Set<number>;
  eof: number | null;
}

const NEW_FILE_RE = /^--- \/dev\/null\r?\n\+\+\+ b\/(.+?)\r?$/gm;

function visibleLinesByPath(diffText: string): Map<string, VisibleFile> {
  const files = new Map<string, VisibleFile>();
  walkDiff(diffText, (line) => {
    let file = files.get(line.path);
    if (!file) {
      file = { text: new Map(), added: new Set(), eof: null };
      files.set(line.path, file);
    }
    file.text.set(line.lineno, line.text);
    if (line.added) file.added.add(line.lineno);
  });
  for (const m of diffText.matchAll(NEW_FILE_RE)) {
    const file = files.get(m[1]!);
    if (file) file.eof = Math.max(...file.text.keys());
  }
  return files;
}

/** The file's own text under `root`, or `null` when it cannot be read. */
function fileAtRoot(root: string, path: string): VisibleFile | null {
  try {
    const lines = readFileSync(`${root}/${path}`, 'utf-8').split(/\r?\n/);
    const text = new Map(lines.map((t, i): [number, string] => [i + 1, t]));
    return { text, added: new Set(), eof: lines.length };
  } catch {
    return null;
  }
}

/** The enclosing test's declaration line in the contiguous visible run, or null. */
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

/** Python: a block closes before the first non-blank line dedented to `def`. */
function pythonBlockEnd(file: VisibleFile, start: number): number | null {
  const declIndent = indentWidth(file.text.get(start)!);
  let n = start + 1;
  for (; file.text.has(n); n++) {
    const text = file.text.get(n)!;
    if (text.trim() && indentWidth(text) <= declIndent) return n - 1;
  }
  return n - 1 === file.eof ? n - 1 : null;
}

/**
 * The last line of the block opened at `start`, or `null` when its end is not
 * inside the visible run (#929). JS/TS closes when delimiter depth returns to
 * zero. An unknown end means the assertion may be exactly what is out of view
 * — the dominant case, since a test's setup is edited far more than its
 * `expect` — so the caller abstains rather than scoring half a block.
 */
function blockEnd(
  file: VisibleFile,
  start: number,
  isPython: boolean,
): number | null {
  if (isPython) return pythonBlockEnd(file, start);
  let depth = 0;
  let opened = false;
  let n = start;
  for (; file.text.has(n); n++) {
    const code = file.text.get(n)!.replace(JS_STRING_OR_COMMENT, '');
    const opens = code.replace(/[^{(]/g, '').length;
    depth += opens - code.replace(/[^})]/g, '').length;
    opened ||= opens > 0;
    if (opened && depth <= 0) return n;
  }
  return n - 1 === file.eof ? n - 1 : null;
}

function linesOf(file: VisibleFile, start: number, end: number): string[] {
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = file.text.get(n);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** Same-file helpers whose CLOSED body asserts, from diff and disk text (#929). */
function assertingHelpers(sources: VisibleFile[], framework: string): string[] {
  const names = new Set<string>();
  for (const src of sources) {
    for (const n of src.text.keys()) {
      const name = assertingHelperAt(src, n, framework);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** The helper defined at line `n` when its closed body asserts, else null. */
function assertingHelperAt(
  src: VisibleFile,
  n: number,
  framework: string,
): string | null {
  const isPython = framework === 'pytest';
  const m = (isPython ? HELPER_DEF_PY : HELPER_DEF_JS).exec(src.text.get(n)!);
  const name = m?.[1] ?? m?.[2];
  const end = name ? blockEnd(src, n, isPython) : null;
  if (end === null) return null;
  return hasAssertion(linesOf(src, n, end).join('\n'), framework)
    ? name!
    : null;
}

/** True iff the block asserts nothing and has an added body to judge. */
function isWeakBlock(
  file: VisibleFile,
  [start, end]: LineRange,
  framework: string,
  helpers: string[],
): boolean {
  const span = linesOf(file, start, end);
  const added = linesOf(file, start, end).filter((_, i) =>
    file.added.has(start + i),
  );
  // FP-3: only a signature was added over an unchanged body. A wholly added
  // block (e.g. `it('x', () => {})` on one line) is still judged.
  if (!hasAddedTestBody(added) && added.length < span.length) return false;
  const code = span.join('\n');
  if (!isAssertionFreeTest(code, framework)) return false;
  return !helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(code));
}

/** The weak test blocks touched by `unit`'s added lines, each visited once. */
function weakBlocksIn(
  file: VisibleFile,
  unit: ChangedUnit,
  framework: string,
  helpers: string[],
): LineRange[] {
  const declRe = framework === 'pytest' ? TEST_DECL_PY : TEST_DECL_JS;
  const seen = new Set<number>();
  const weak: LineRange[] = [];
  for (const lineNo of linesInRanges(unit.added_ranges)) {
    const start = enclosingTestDecl(file, lineNo, declRe);
    if (start === null || seen.has(start)) continue;
    seen.add(start);
    const end = blockEnd(file, start, framework === 'pytest');
    if (end === null) continue;
    if (isWeakBlock(file, [start, end], framework, helpers)) {
      weak.push([start, end]);
    }
  }
  return weak;
}

function testTitle(decl: string): string {
  const m = TEST_TITLE_RE.exec(decl);
  return m?.[2] ?? m?.[3] ?? decl.trim();
}

/**
 * Advisory `weak-test` findings for ADDED tests that assert nothing — one per
 * weak test block, naming its title and line span (#929).
 *
 * The span scored is the ENCLOSING TEST BLOCK (#747); a block that cannot be
 * resolved, or whose end is out of view, is abstained on. `repoRoot` is where
 * the file's own text is read for helper resolution (`.`, the CLI's repoRoot
 * convention). Findings are `LOW` and never gated (see computeExitCode).
 */
export function buildWeakTestFindings(
  testUnits: ChangedUnit[],
  diffText: string,
  repoRoot = '.',
): GuardianFinding[] {
  const addedByPath = addedContentByPath(diffText);
  const visibleByPath = visibleLinesByPath(diffText);
  const findings: GuardianFinding[] = [];
  for (const unit of testUnits) {
    const file = visibleByPath.get(unit.path);
    if (!file || !addedByPath.get(unit.path)?.length) continue;
    const framework = frameworkForTestPath(unit.path);
    const disk = fileAtRoot(repoRoot, unit.path);
    const helpers = assertingHelpers(disk ? [file, disk] : [file], framework);
    for (const [start, end] of weakBlocksIn(file, unit, framework, helpers)) {
      const title = testTitle(file.text.get(start)!);
      findings.push(
        new GuardianFinding({
          path: unit.path,
          unit: unit.path,
          kind: 'weak-test',
          fidelity: Fidelity.Heuristic,
          severity: Severity.LOW,
          evidence: `added test "${title}" (L${start}–L${end}) asserts nothing (advisory — never blocks the gate)`,
          suggestion:
            'add at least one assertion, or delete the test if it is a placeholder.',
          added_ranges: [[start, end]],
        }),
      );
    }
  }
  return findings;
}
