/**
 * #1314: lcov records a multi-line statement on ONE line, so a ternary arm or
 * chain link has no `DA:` record yet runs. One linear pass groups lines into
 * statements; an unrecorded line takes its statement's first recorded line,
 * and a statement recorded nowhere is the instrumenter's non-executable. What
 * cannot be judged fails CLOSED: a wrong "executable" is one noisy finding.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QUOTES, stepQuote, stripComments } from '../type-only.js';
import {
  expandRanges,
  matchFile,
  splitLines,
  type ChangedUnit,
  type FileCoverage,
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

/** The root or one block's inside; `owner`: current statement's first record. */
interface Ctx {
  parent: Ctx | null;
  live: boolean;
  exprDepth: number;
  ended: boolean;
  owner: number | null;
  pending: number[];
}

type LineMap = Map<number, number>;

interface Pass {
  frames: Frame[];
  ctx: Ctx;
  before: string;
  inTemplate?: boolean;
  lost: boolean; // unbalanced brackets: the grouping is not trusted
}

const FRESH = { live: true, exprDepth: 0, ended: false, owner: null };
const newCtx = (parent: Ctx | null): Ctx => ({ ...FRESH, parent, pending: [] });

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

/** The opener each closer pairs with; both kinds of brace frame read as `{`. */
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const opener = (f: Frame): string => (f === '(' || f === '[' ? f : '{');

/** Pop one frame; a block closed at statement level ends that statement. */
function close(ch: string, p: Pass): void {
  const frame = p.frames.pop();
  if (frame === undefined || OPENER[ch] !== opener(frame)) {
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
function place(ln: number, ctx: Ctx, rec: boolean, out: LineMap): void {
  if (rec && ctx.owner === null) {
    ctx.owner = ln;
    for (const q of ctx.pending) out.set(q, ln);
    ctx.pending = [];
  }
  if (rec) out.set(ln, ln);
  else if (ctx.owner !== null) out.set(ln, ctx.owner);
  else ctx.pending.push(ln);
}

/** One forward pass: every non-blank line mapped to its statement's owner. */
function groupStatements(code: string[], measured: ReadonlySet<number>) {
  const p: Pass = { frames: [], ctx: newCtx(null), before: '', lost: false };
  const map: LineMap = new Map();
  let prev = '';
  for (let ln = 1; ln < code.length && !p.lost; ln++) {
    const line = code[ln]!.trim();
    if (line === '') continue;
    const start = p.ctx;
    if (!continues(start, p, prev, line)) {
      Object.assign(start, { ended: false, owner: null, pending: [] });
    }
    scanLine(code[ln]!, p);
    // A line closing its own block (`})`, `} else {`) joins the enclosing one.
    let ctx = start;
    while (!ctx.live) ctx = ctx.parent!;
    place(ln, ctx, measured.has(ln), map);
    prev = line;
  }
  return { map, lost: p.lost || p.frames.length > 0 || p.inTemplate === true };
}

/**
 * Lost lexer: every non-blank line is code, scored by the nearest record above.
 * A line with no record above it (imports, a signature before the first `DA:`)
 * gets none: there is no statement to inherit from, so it stays non-coverable,
 * as a statement recorded nowhere does in a trusted pass (#1408).
 */
function nearestRecordAbove(code: string[], measured: ReadonlySet<number>) {
  const map: LineMap = new Map();
  let last: number | null = null;
  for (let ln = 1; ln < code.length; ln++) {
    if (measured.has(ln)) last = ln;
    if (last !== null && code[ln]!.trim() !== '') map.set(ln, last);
  }
  return map;
}

/** Changed line -> the line whose hits decide it; `null`: cannot judge at all. */
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

/** `index` (copied) with continuation lines folded in; unjudgeable: unmeasured. */
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
    out[key] = fold(file, attributeLines(added, file.coverable, source));
  }
  return out;
}

/** `file` with `at`'s lines folded in; `null` coverable fails closed. */
function fold(file: FileCoverage, at: LineMap | null): FileCoverage {
  const hits: LineHits = Object.assign(Object.create(null), file.hits);
  for (const [ln, m] of at ?? []) hits[ln] = file.hits[m] ?? 0;
  const coverable = at && new Set([...file.coverable!, ...at.keys()]);
  return { ...file, hits, coverable };
}
