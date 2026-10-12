/**
 * Proof that a module has no runtime content at all (#562) — the one
 * suppression that is about the FILE rather than the fidelity tier.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { splitLines } from './types.js';

/**
 * Filenames/paths that plausibly hold nothing but type declarations (#562).
 *
 * A NAME GATE ONLY -- it decides which files are worth reading, never which
 * are suppressed. {@link isTypeOnlyModule} always confirms against content,
 * because a `types.ts` that also exports an enum or a const map is ordinary
 * TypeScript and its findings are real.
 */
function isTypeModuleCandidate(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.endsWith('.d.ts')) return true;
  if (!/\.(ts|tsx|mts|cts)$/.test(base)) return false;
  if (base === 'types.ts' || base.endsWith('.types.ts')) return true;
  return path.split('/').slice(0, -1).includes('types');
}

/**
 * True if `path` is a module with no runtime content at all (#562).
 *
 * The false-positive class this closes is the one the heuristic-tier fix
 * (#413) structurally cannot reach. `filterHeuristicNoise` is gated on
 * `fidelity === HEURISTIC` on purpose -- a coverage-verified verdict rests on
 * a real lcov row, so suppressing by path at that tier would discard
 * evidence. A type-only module is the case that breaks the symmetry: the lcov
 * row is accurate (39 lines, genuinely never executed) and the finding is
 * still unsatisfiable, because an interface has no runtime existence for a
 * test to reach. The evidence needed is therefore about the FILE, not the
 * tier: prove there is nothing executable in it.
 *
 * Conservative in one direction on purpose. Every uncertainty -- an
 * unreadable file, an unrecognised construct -- resolves to `false`, keeping
 * the finding. A missed suppression costs one noisy finding; a wrong
 * suppression hides untested code, which is the thing the guardian exists to
 * catch.
 */
export function isTypeOnlyModule(path: string, repoRoot: string): boolean {
  if (!isTypeModuleCandidate(path)) return false;
  let source: string;
  try {
    source = readFileSync(join(repoRoot, path), 'utf-8');
  } catch {
    return false; // unreadable -> unproven -> keep the finding
  }
  return isTypeOnlySource(source);
}

/** Drop `//` and `/* *\/` comments so keywords inside prose never count. */
function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of splitLines(source)) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = commentStart(text);
      if (start === -1) break;
      if (text[start + 1] === '/') {
        text = text.slice(0, start);
        break;
      }
      const end = text.indexOf('*/', start + 2);
      if (end === -1) {
        text = text.slice(0, start);
        inBlock = true;
        break;
      }
      text = text.slice(0, start) + text.slice(end + 2);
    }
    out.push(text);
  }
  return out.join('\n');
}

/**
 * Index of the first `//` or `/*` that is NOT inside a string literal, or -1.
 *
 * A glob-typed literal such as `'**\/*.test.ts'` is ordinary in a types file;
 * read as a comment opener, its `/*` blanked every following line, so runtime
 * code after it was never judged and the module was wrongly suppressed. A
 * quote left open at end of line just ends the scan: the rest stays code,
 * which can only keep a finding, never hide one.
 */
function commentStart(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (QUOTES.has(ch)) {
      quote = ch;
    } else if (opensComment(text, i)) {
      return i;
    }
  }
  return -1;
}

const QUOTES: ReadonlySet<string> = new Set(["'", '"', '`']);
const COMMENT_SECOND: ReadonlySet<string> = new Set(['/', '*']);

/** True if a `//` or `/*` begins at `text[i]`. */
function opensComment(text: string, i: number): boolean {
  return text[i] === '/' && COMMENT_SECOND.has(text[i + 1] ?? '');
}

/**
 * Top-level constructs TypeScript erases entirely at compile time (#562).
 *
 * An ALLOWLIST, not a denylist, and that is the load-bearing choice. A
 * denylist of runtime keywords misses everything it did not enumerate -- a
 * bare `register('widget')` declares nothing and still runs -- and every gap
 * in it suppresses a real finding. An allowlist fails the other way: an
 * unrecognised construct reads as runtime and the finding survives.
 *
 * Plain `import { X } from '...'` is allowed because TypeScript elides an
 * import whose bindings are only used in type positions; if a binding were
 * used as a value, the using statement itself would appear at top level and
 * be rejected. A side-effect `import './x'` carries no binding, is never
 * elided, and is therefore not matched.
 */
function isErasableTopLevelLine(line: string): boolean {
  if (line === '') return true;
  if (/^[})\];,]+$/.test(line)) return true;
  if (/^import\s+type\b/.test(line)) return true;
  if (/^import\b.*\sfrom\s/.test(line)) return true;
  if (/^export\s+type\b/.test(line)) return true;
  const bare = line.replace(
    /^(?:export\s+default\s+|export\s+|declare\s+)+/,
    '',
  );
  return /^(?:interface|type)\s/.test(bare);
}

/**
 * True if every TOP-LEVEL statement in `source` is compile-time-only.
 *
 * Brace depth is tracked so an interface body is never mistaken for
 * statements: only depth-0 lines are judged. An unbalanced file (depth does
 * not return to zero) is treated as unproven rather than type-only -- brace
 * counting is lexical, so a `{` inside a string literal could otherwise hide
 * the rest of the file from inspection.
 */
function isTypeOnlySource(source: string): boolean {
  const scan: Scan = { depth: 0, inInterface: false };
  for (const raw of splitLines(stripComments(source))) {
    if (!scanLine(raw.trim(), scan)) return false;
  }
  return scan.depth === 0;
}

/** Nesting state carried across lines. */
interface Scan {
  depth: number;
  /** The open top-level statement is an interface, so its `}` ends it. */
  inInterface: boolean;
}

/**
 * Judge every top-level statement that STARTS on `line`, not only the first.
 *
 * A statement starts at the line's beginning (when at depth 0), after a
 * depth-0 `;`, and after the `}` that closes an interface. Judging by line
 * prefix alone let `export type A = string; register('x');` or an interface
 * closed by `} register('x');` pass as type-only, hiding the call. A type
 * alias's `}` does not end it (`} & Base;` continues the alias). Brackets and
 * `;` inside string literals are ignored.
 */
function scanLine(line: string, scan: Scan): boolean {
  if (scan.depth === 0 && !startStatement(line, scan)) return false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    if (quote !== null || QUOTES.has(line[i]!)) {
      [quote, i] = stepQuote(line, i, quote);
    } else if (!stepCode(line, i, scan)) {
      return false;
    }
  }
  return true;
}

/**
 * Consume one code character (outside any string): track nesting, and judge
 * the next statement when this character ends the current one. False on an
 * unbalanced closer or a non-erasable statement.
 */
function stepCode(line: string, i: number, scan: Scan): boolean {
  const ch = line[i]!;
  scan.depth += BRACKET_DELTA[ch] ?? 0;
  if (scan.depth < 0) return false;
  return !endsStatement(ch, scan) || startStatement(line.slice(i + 1), scan);
}

const BRACKET_DELTA: Readonly<Record<string, number>> = {
  '{': 1,
  '(': 1,
  '[': 1,
  '}': -1,
  ')': -1,
  ']': -1,
};

/** Advance through a string literal: the new quote state and index. */
function stepQuote(
  line: string,
  i: number,
  quote: string | null,
): [string | null, number] {
  const ch = line[i]!;
  if (quote === null) return [ch, i];
  if (ch === '\\') return [quote, i + 1];
  return [ch === quote ? null : quote, i];
}

/** True if `ch`, just consumed, closed the current top-level statement. */
function endsStatement(ch: string, scan: Scan): boolean {
  if (scan.depth !== 0) return false;
  return ch === ';' || (ch === '}' && scan.inInterface);
}

/** Judge the statement starting at `rest`, recording whether it is an interface. */
function startStatement(rest: string, scan: Scan): boolean {
  const text = rest.replace(/^[\s;]+/, '');
  scan.inInterface =
    /^(?:export\s+(?:default\s+)?|declare\s+)*interface\s/.test(text);
  return isErasableTopLevelLine(text);
}
