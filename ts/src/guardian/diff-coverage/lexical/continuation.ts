/**
 * Multi-line statement continuation (#1314).
 *
 * v8/istanbul lcov (and coverage.py) record a multi-line statement on ONE line.
 * A ternary's arms, the terms of a multi-line `a +\n b` initializer and the
 * links of a method chain get no `DA:` record of their own, yet they are
 * executable. Reading "absent from the measured set" as "not executable"
 * headlined such diffs "only non-executable lines changed" — a false green.
 *
 * This module attributes an unmeasured changed line to the measured line of
 * the statement it continues, judged lexically from the source at head. The
 * direction of error is chosen on purpose: a line wrongly judged a
 * continuation costs one noisy finding; a line wrongly judged non-executable
 * hides untested code, which is what the guardian exists to catch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QUOTES, stepQuote, stripComments } from '../type-only.js';
import { splitLines } from '../types.js';

/** An open bracket; `{` is split into object-literal (`expr`) vs block. */
type Frame = '(' | '[' | 'expr' | 'block';

/** A line ending in one of these hands its statement on to the next line. */
const TRAILING_OP = /(?:[=+\-*/%&|^?:,.<>!~\\]|\breturn)$/;
/** A line starting with one of these continues the previous line's statement. */
const LEADING_OP = /^(?:[.?:+\-*/%&|^=<>]|\?\?|&&|\|\|)/;
/** The token before a `{` that makes it an object literal, not a block. */
const EXPR_BEFORE_BRACE = /(?:[=([,:?!&|+]|\breturn|\byield|\bawait)$/;

interface ScanState {
  stack: Frame[];
  /** The significant code consumed so far, for classifying a `{`. */
  before: string;
  /** A template literal open across a line break. */
  inTemplate: boolean;
  /** The scanned statement ended (`;` or a block close at depth 0). */
  ended: boolean;
}

const fresh = (): ScanState => ({
  stack: [],
  before: '',
  inTemplate: false,
  ended: false,
});

/** Consume one line of comment-free code. False when it closes past the start. */
function scanLine(code: string, st: ScanState): boolean {
  let quote: string | null = st.inTemplate ? '`' : null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (quote !== null || QUOTES.has(ch)) {
      [quote, i] = stepQuote(code, i, quote);
    } else if (!stepCode(ch, st)) {
      return false;
    } else if (ch.trim() !== '') {
      st.before = (st.before + ch).slice(-8);
    }
  }
  st.inTemplate = quote === '`';
  return true;
}

const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/** Track one code character's effect on nesting and statement end. */
function stepCode(ch: string, st: ScanState): boolean {
  if (ch === '(' || ch === '[') st.stack.push(ch);
  else if (ch === '{') st.stack.push(braceKind(st.before));
  else if (CLOSERS.has(ch)) return close(ch, st);
  else if (ch === ';' && st.stack.length === 0) st.ended = true;
  return true;
}

const braceKind = (before: string): Frame =>
  EXPR_BEFORE_BRACE.test(before) ? 'expr' : 'block';

/** Pop one frame; a block closed back to the start ends the statement. */
function close(ch: string, st: ScanState): boolean {
  if (st.stack.pop() === undefined) return false;
  if (ch === '}' && st.stack.length === 0) st.ended = true;
  return true;
}

/** True if line `l` continues the statement that starts on measured line `m`. */
function continues(code: string[], m: number, l: number): boolean {
  const st = fresh();
  let last = '';
  for (let i = m; i < l; i++) {
    if (!scanLine(code[i]!, st) || st.ended) return false;
    if (code[i]!.trim() !== '') last = code[i]!.trim();
  }
  const top = st.stack.at(-1);
  if (st.inTemplate || (top !== undefined && top !== 'block')) return true;
  return TRAILING_OP.test(last) || LEADING_OP.test(code[l]!.trim());
}

/** True if line `l` alone leaves its statement open onto the next line. */
function opensInto(line: string): boolean {
  const st = fresh();
  if (!scanLine(line, st) || st.ended) return false;
  const top = st.stack.at(-1);
  if (top !== undefined) return top !== 'block';
  return TRAILING_OP.test(line.trim());
}

/** The measured line whose statement unmeasured line `l` belongs to, or null. */
function statementLine(
  code: string[],
  measured: ReadonlySet<number>,
  l: number,
): number | null {
  let m = l - 1;
  while (m >= 1 && !measured.has(m)) m--;
  if (m >= 1 && continues(code, m, l)) return m;
  let n = l + 1;
  while (n < code.length && code[n]!.trim() === '') n++;
  return measured.has(n) && opensInto(code[l]!) ? n : null;
}

/** Comment-free code lines, 1-based (index 0 unused). */
function codeLines(source: string, path: string): string[] {
  const lines = splitLines(stripComments(source));
  // coverage.py sources: a whole-line `#` comment is never a continuation.
  const hash = path.endsWith('.py');
  return ['', ...lines.map((l) => (hash && /^\s*#/.test(l) ? '' : l))];
}

/**
 * Map each changed line the report can score to the measured line whose hits
 * decide it: a measured line maps to itself, a continuation line to its
 * statement's measured line (#1314). Lines absent from the map are
 * non-executable. With no source, only measured lines are scored — the
 * pre-#1314 behaviour, never a guess.
 */
export function attributeLines(
  added: number[],
  measured: ReadonlySet<number>,
  source: string | null,
  path: string,
): Map<number, number> {
  const code = source === null ? null : codeLines(source, path);
  const out = new Map<number, number>();
  for (const ln of added) {
    if (measured.has(ln)) out.set(ln, ln);
    else if (code !== null && (code[ln] ?? '').trim() !== '') {
      const at = statementLine(code, measured, ln);
      if (at !== null) out.set(ln, at);
    }
  }
  return out;
}

/** A reader for repo-relative source at head; `null` when unreadable. */
export function sourceReader(repoRoot: string) {
  return (path: string): string | null => {
    try {
      return readFileSync(join(repoRoot, path), 'utf-8');
    } catch {
      return null;
    }
  };
}
