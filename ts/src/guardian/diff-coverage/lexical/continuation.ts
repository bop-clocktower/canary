/**
 * Multi-line statement continuation (#1314).
 *
 * v8/istanbul lcov (and coverage.py) record a multi-line statement on ONE line.
 * A ternary's arms, the terms of a multi-line `a +\n b` initializer and the
 * links of a method chain get no `DA:` record of their own, yet they are
 * executable. Reading "absent from the measured set" as "not executable"
 * headlined such diffs "only non-executable lines changed" — a false green.
 *
 * One linear pass over the source groups lines into statements, and each
 * unrecorded changed line is scored by the first recorded line of its
 * statement. A statement with no recorded line at all is one the instrumenter
 * itself judged non-executable (a type, a signature, an import). Everything
 * the lexer cannot judge fails CLOSED, toward "executable": a wrong
 * "executable" costs one noisy finding, a wrong "non-executable" hides
 * untested code, which is what the guardian exists to catch.
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

/** Sources larger than this are not scanned; the caller fails closed. */
const MAX_SOURCE_CHARS = 2_000_000;

/** A line ending in one of these hands its statement on to the next line. */
const TRAILING_OP =
  /(?:[=+\-*/%&|^?:,.<>!~\\]|\b(?:return|await|yield|new|typeof|in|of|instanceof|throw))$/;
/** A line starting with one of these continues the previous line's statement. */
const LEADING_OP =
  /^(?:[.?:+\-*/%&|^=<>]|\?\?|&&|\|\||(?:as|in|instanceof|satisfies)\b)/;
/** The token before a `{` that makes it an object literal, not a block. */
const EXPR_BEFORE_BRACE = /(?:[=([,:?!&|+]|\breturn|\byield|\bawait)$/;
/** The token before a `/` that makes it a regex literal, not division. */
const REGEX_BEFORE = /(?:^|[=([,:?!&|{};+\-*%<>~^]|\breturn|\btypeof)$/;

/** An open bracket; `{` is split into object-literal (`expr`) vs block. */
type Frame = '(' | '[' | 'expr' | 'block';

/** One statement sequence: the root, or the inside of one `{ }` block. */
interface Ctx {
  parent: Ctx | null;
  live: boolean;
  /** Open `(`, `[` and object-literal `{` inside the current statement. */
  exprDepth: number;
  ended: boolean;
  /** The first recorded line of the current statement. */
  owner: number | null;
  /** Unrecorded lines of the current statement seen before its owner. */
  pending: number[];
}

interface Pass {
  frames: Frame[];
  ctx: Ctx;
  before: string;
  inTemplate?: boolean;
  /** The lexer lost track (unbalanced brackets); its grouping is not trusted. */
  lost: boolean;
}

const newCtx = (parent: Ctx | null): Ctx => ({
  parent,
  live: true,
  exprDepth: 0,
  ended: false,
  owner: null,
  pending: [],
});

/** Consume one line of comment-free code, updating nesting and statement end. */
function scanLine(code: string, p: Pass): void {
  let quote: string | null = p.inTemplate ? '`' : null;
  for (let i = 0; i < code.length && !p.lost; i++) {
    const ch = code[i]!;
    if (quote !== null || QUOTES.has(ch)) {
      [quote, i] = stepQuote(code, i, quote);
    } else if (ch === '/' && REGEX_BEFORE.test(p.before)) {
      i = skipRegex(code, i);
    } else {
      stepCode(ch, p);
      if (ch.trim() !== '') p.before = (p.before + ch).slice(-8);
    }
  }
  p.inTemplate = quote === '`';
}

/** Index of a regex literal's closing `/` (or the line end) from its opening. */
function skipRegex(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '\\') i++;
    else if (ch === '[' || ch === ']') inClass = ch === '[';
    else if (ch === '/' && !inClass) return i;
  }
  return code.length;
}

/** Track one code character's effect on nesting and statement end. */
function stepCode(ch: string, p: Pass): void {
  if (ch === '(' || ch === '[') open(ch, p);
  else if (ch === '{') {
    open(EXPR_BEFORE_BRACE.test(p.before) ? 'expr' : 'block', p);
  } else if (ch === ')' || ch === ']' || ch === '}') close(ch, p);
  else if (ch === ';' && p.ctx.exprDepth === 0) p.ctx.ended = true;
}

function open(frame: Frame, p: Pass): void {
  p.frames.push(frame);
  if (frame === 'block') p.ctx = newCtx(p.ctx);
  else p.ctx.exprDepth++;
}

const MATCHES: Readonly<Record<string, readonly Frame[]>> = {
  ')': ['('],
  ']': ['['],
  '}': ['expr', 'block'],
};

/** Pop one frame; a block closed at statement level ends that statement. */
function close(ch: string, p: Pass): void {
  const frame = p.frames.pop();
  if (frame === undefined || !MATCHES[ch]!.includes(frame)) {
    p.lost = true;
  } else if (frame !== 'block') {
    p.ctx.exprDepth--;
  } else {
    p.ctx.live = false;
    p.ctx = p.ctx.parent!;
    if (p.ctx.exprDepth === 0) p.ctx.ended = true;
  }
}

/** True if a line starting in `ctx` continues that context's open statement. */
function continues(ctx: Ctx, p: Pass, prev: string, line: string): boolean {
  if (ctx.ended) return false;
  if (p.inTemplate || ctx.exprDepth > 0) return true;
  return TRAILING_OP.test(prev) || LEADING_OP.test(line);
}

/** Score line `ln` within `ctx`'s statement, recording it in `out` if wanted. */
function place(
  ln: number,
  ctx: Ctx,
  recorded: boolean,
  out: Map<number, number>,
) {
  if (recorded && ctx.owner === null) {
    ctx.owner = ln;
    for (const q of ctx.pending) out.set(q, ln);
    ctx.pending = [];
  }
  if (recorded) out.set(ln, ln);
  else if (ctx.owner !== null) out.set(ln, ctx.owner);
  else ctx.pending.push(ln);
}

/** One forward pass: every non-blank line mapped to its statement's owner. */
function groupStatements(
  code: string[],
  measured: ReadonlySet<number>,
): { map: Map<number, number>; lost: boolean } {
  const p: Pass = { frames: [], ctx: newCtx(null), before: '', lost: false };
  const map = new Map<number, number>();
  let prev = '';
  for (let ln = 1; ln < code.length && !p.lost; ln++) {
    const line = code[ln]!.trim();
    if (line === '') continue;
    const start = p.ctx;
    if (!continues(start, p, prev, line)) {
      Object.assign(start, { ended: false, owner: null, pending: [] });
    }
    scanLine(code[ln]!, p);
    // A line that closes its own block (`})`, `}).then(…)`, `} else {`)
    // belongs to the statement that encloses the block.
    let ctx = start;
    while (!ctx.live) ctx = ctx.parent!;
    place(ln, ctx, measured.has(ln), map);
    prev = line;
  }
  return { map, lost: p.lost || p.frames.length > 0 || p.inTemplate === true };
}

/** Lost lexer: every non-blank line is code, scored by the nearest record above. */
function nearestRecordAbove(
  code: string[],
  measured: ReadonlySet<number>,
): Map<number, number> {
  const map = new Map<number, number>();
  let last = 0; // line 0 has no hits, so an orphan line reads as uncovered
  for (let ln = 1; ln < code.length; ln++) {
    if (measured.has(ln)) last = ln;
    if (code[ln]!.trim() !== '') map.set(ln, last);
  }
  return map;
}

/**
 * Map each changed line the report can score to the line whose hits decide
 * it: a recorded line maps to itself, an unrecorded line to its statement's
 * first recorded line (#1314). Lines absent from the map are blank, comments,
 * or in a statement the instrumenter recorded nowhere. `null` means the
 * source cannot be judged at all — missing, too large, or shorter than the
 * diff (so not the source the diff describes) — and the caller fails closed.
 */
export function attributeLines(
  added: number[],
  measured: ReadonlySet<number>,
  source: string | null,
): Map<number, number> | null {
  if (source === null || source.length > MAX_SOURCE_CHARS) return null;
  const code = ['', ...splitLines(stripComments(source))];
  if (added.some((ln) => ln >= code.length)) return null;
  const grouped = groupStatements(code, measured);
  const all = grouped.lost ? nearestRecordAbove(code, measured) : grouped.map;
  const out = new Map<number, number>();
  for (const ln of added) {
    // A recorded line always scores itself, whatever the grouping says.
    const at = measured.has(ln) ? ln : all.get(ln);
    if (at !== undefined) out.set(ln, at);
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
 * tier scores them like any recorded line. A file whose source cannot be
 * judged loses its measured set instead: the report tier then scores every
 * changed line and absence means uncovered (fail closed). Entries are copied,
 * never mutated; a file whose report never said what it measured is left as is.
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
    const at = attributeLines(added, file.coverable, source);
    if (at === null) {
      out[key] = { hits: file.hits, coverable: null };
      continue;
    }
    const hits: LineHits = Object.assign(Object.create(null), file.hits);
    for (const [ln, m] of at) hits[ln] = file.hits[m] ?? 0;
    const coverable = new Set([...file.coverable, ...at.keys()]);
    out[key] = { hits, coverable };
  }
  return out;
}
