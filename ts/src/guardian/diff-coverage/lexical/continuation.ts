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
import {
  expandRanges,
  matchFile,
  splitLines,
  type ChangedUnit,
  type LineHits,
  type ReportIndex,
} from '../types.js';

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

/** How far back (in lines) a continuation's statement start is looked for. */
const MAX_SPAN = 80;

/** The measured line whose statement unmeasured line `l` belongs to, or null. */
function statementLine(
  code: string[],
  measured: ReadonlySet<number>,
  l: number,
): number | null {
  // Nearest recorded line first, then further back: the nearest can sit inside
  // a callback or argument list that closed before `l` (`.map(…{…})` then
  // `.filter()`). The span bounds the quadratic scan on a large diff.
  for (let m = l - 1; m >= 1 && l - m <= MAX_SPAN; m--) {
    if (measured.has(m) && continues(code, m, l)) return m;
  }
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

/** Repo-relative source at head; `null` when unreadable. */
function readSource(repoRoot: string, path: string): string | null {
  try {
    return readFileSync(join(repoRoot, path), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * `index` with each changed unit's continuation lines folded into its file's
 * measured set, each carrying its statement line's hits (#1314), so the report
 * tier scores them like any recorded line. Entries are copied, never mutated;
 * a file whose report never said what it measured is left as is.
 */
export function withContinuations(
  units: ChangedUnit[],
  index: ReportIndex,
  repoRoot: string,
): ReportIndex {
  const out: ReportIndex = Object.assign(Object.create(null), index);
  for (const unit of units) {
    const file = matchFile(unit.path, out);
    const key = Object.keys(out).find((k) => out[k] === file);
    if (!file?.coverable || key === undefined) continue;
    const source = readSource(repoRoot, unit.path);
    const added = expandRanges(unit.added_ranges);
    const at = attributeLines(added, file.coverable, source, unit.path);
    const hits: LineHits = Object.assign(Object.create(null), file.hits);
    for (const [ln, m] of at) hits[ln] = file.hits[m] ?? 0;
    const coverable = new Set([...file.coverable, ...at.keys()]);
    out[key] = { hits, coverable };
  }
  return out;
}
