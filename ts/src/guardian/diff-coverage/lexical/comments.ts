/**
 * The comment and literal lexing shared by the guardian passes that read source
 * text: the type-only detector and the continuation lexer. One copy, because
 * passes that disagree would read the same `/` two ways (#1515).
 */

import { splitLines } from '../types.js';

/** Comment state carried across lines. */
interface CommentScan {
  inBlock: boolean;
  /** The code before the current position, for {@link startsRegex}. */
  before: string;
}

/** Drop `//` and `/* *\/` comments so keywords inside prose never count. */
export function stripComments(source: string): string {
  const scan: CommentScan = { inBlock: false, before: '' };
  return splitLines(source)
    .map((line) => stripLine(line, scan))
    .join('\n');
}

/** `line` without its comments, in one forward pass. */
function stripLine(line: string, scan: CommentScan): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (scan.inBlock) {
      const end = line.indexOf('*/', i);
      if (end === -1) return out;
      scan.inBlock = false;
      i = end + 2;
      continue;
    }
    const start = commentStart(line, i, scan);
    out += line.slice(i, start);
    if (line[start + 1] !== '*') return out;
    scan.inBlock = true;
    i = start + 2;
  }
  return out;
}

/**
 * Index of the first `//` or `/*` at or after `from` that is NOT inside a
 * string or regex literal, or the line's length.
 *
 * A glob-typed literal such as `'**\/*.test.ts'` is ordinary in a types file;
 * read as a comment opener, its `/*` blanked every following line, so runtime
 * code after it was never judged and the module was wrongly suppressed. A
 * regex has the same shape (`/^\.\//`, #1515). A quote left open at end of
 * line just ends the scan: the rest stays code, which can only keep a finding,
 * never hide one.
 *
 * The comment check comes first because no regex can start with `//` or `/*`.
 * That makes a stale regex context harmless at the common `'x' // note`.
 *
 * A guessed regex with a quote in it ends the scan the same way. If the guess
 * was wrong, its end sits inside a string and the next quote opens rather than
 * closes, which exposes a `/*` that really is string text. Reading it as
 * division instead does the same to a real `/'/`. Neither reading can be trusted
 * here, so nothing later on the line counts as a comment.
 */
function commentStart(line: string, from: number, scan: CommentScan): number {
  let quote: string | null = null;
  for (let i = from; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null || QUOTES.has(ch)) {
      [quote, i] = stepQuote(line, i, quote);
    } else if (opensComment(line, i)) {
      return i;
    } else if (startsRegex(ch, scan.before)) {
      const end = skipRegex(line, i);
      if (hasQuote(line, i, end)) return line.length;
      i = end;
    } else {
      scan.before = afterCode(scan.before, ch);
    }
  }
  return line.length;
}

export const QUOTES: ReadonlySet<string> = new Set(["'", '"', '`']);
const COMMENT_SECOND: ReadonlySet<string> = new Set(['/', '*']);

/** True if a `//` or `/*` begins at `text[i]`. */
function opensComment(text: string, i: number): boolean {
  return text[i] === '/' && COMMENT_SECOND.has(text[i + 1] ?? '');
}

/** The token before a `/` that makes it a regex literal, not division. */
const REGEX_BEFORE = /(?:^|[=([,:?!&|{};+\-*%<>~^]|\breturn|\btypeof)$/;

/**
 * True if the `ch` that follows the code `before` opens a regex literal.
 *
 * The one rule for both passes over a file, here and in the continuation
 * lexer: passes that disagree would read the same `/` two ways. It is a guess.
 *
 * A division read as a regex usually keeps comment text as code, and when the
 * guess crosses a quote {@link commentStart} stops looking for comments. With no
 * quote it can still pair off the first `/` of a real `//`, so a `/*` later in
 * that comment opens a block and blanks the lines up to the next `*\/`:
 * `'x' / b; // a/b/*.ts` (#1583).
 *
 * A regex read as division (after `)`, or a keyword the rule lacks) is what this
 * module did for every regex before #1515: a `//` in it drops the rest of the
 * line, and a `/*` in it drops the lines up to the next `*\/`.
 *
 * The continuation lexer reads a blanked line as non-coverable. The type-only
 * detector fails closed on both, see `stepCode` in `type-only.ts`.
 */
export function startsRegex(ch: string, before: string): boolean {
  return ch === '/' && REGEX_BEFORE.test(before);
}

/** Index of a regex literal's closing `/` (or the line end) from its opening. */
export function skipRegex(code: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '\\') i++;
    else if (ch === '[' || ch === ']') inClass = ch === '[';
    else if (ch === '/' && !inClass) return i;
  }
  return code.length;
}

/** True if an unescaped quote sits between a regex's `start` and `end`. */
function hasQuote(code: string, start: number, end: number): boolean {
  for (let i = start + 1; i < end; i++) {
    if (code[i] === '\\') i++;
    else if (QUOTES.has(code[i]!)) return true;
  }
  return false;
}

/** The context for {@link startsRegex} once the code character `ch` is read. */
export function afterCode(before: string, ch: string): string {
  return ch.trim() === '' ? before : (before + ch).slice(-8);
}

/** Advance through a string literal: the new quote state and index. */
export function stepQuote(
  line: string,
  i: number,
  quote: string | null,
): [string | null, number] {
  const ch = line[i]!;
  if (quote === null) return [ch, i];
  if (ch === '\\') return [quote, i + 1];
  return [ch === quote ? null : quote, i];
}
