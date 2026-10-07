// String-literal ranges for a single source line (pure, stdlib-only). #493.
//
// Both canary-blackhawk and canary-savant regex over raw lines, so without
// this they flag their own test fixtures: `pyFile('time.sleep(1)')` is data,
// not a call. The correction is deliberately narrow -- a match is rejected
// only when its START index falls inside a string literal. Stripping string
// contents before matching would be wrong: blackhawk's BH003 pattern matches
// `strftime('..%Z')` with the `%Z` inside the quotes ON PURPOSE; the anchor
// token (`strftime`, `time.sleep`, `Date.now`, ...) is what separates code
// from data.
//
// This per-line helper is intentionally duplicated verbatim in
// canary-blackhawk and canary-savant, and a parity test pins the two copies
// byte-identical. The JSX masker it calls is NOT duplicated: it lives once in
// the shared agents/skills/lib/ (with parse-args.mjs and is-main.mjs, #479)
// and both copies import it from there.
//
// Fidelity limits (line-based scanner, no parser):
// - Handles '...', "...", and `...` template literals. `${...}` interpolation
//   regions are CODE (a nested-frame scan, so `${`x`}` and `${fn({a:1})}`
//   work); backslash escapes are respected; a quote of the other kind inside
//   a string is content.
// - An unterminated quote marks the REST OF THE LINE as string. That is the
//   safe default for multi-line Python strings whose opener ends mid-line,
//   and this helper only ever REJECTS matches. A quote that is not a
//   delimiter at all must therefore never reach it: a phantom string closes
//   at the next REAL quote, so the fixture after it reads as code and a
//   finding is fabricated (#1192). Comments, regex literals and JSX text are
//   handled below.
// - Strings spanning lines (template literals, triple quotes) are only seen
//   on their opening line; continuation lines look like code. Accepted: the
//   scanners are line-based by design.
// - Comments and regex literals (#1192): in a JS-family file an apostrophe
//   in `/* it's */` or `// it's`, or a quote in `/it's/` or `/['"]/`, is not
//   a delimiter. maskSourceForFile replaces each such quote with a stand-in
//   (lib/js-literals.mjs, whole-file, so a block comment opened on an earlier
//   line counts), and the line is read through that twin. Only the quote
//   characters change: comment text stays code for the rules and pragmas,
//   exactly as an apostrophe-free comment always read. `/` is a regex only
//   where an expression may start (after an operator, `(`, `,`, `=`, `:`,
//   `[`, `{`, `;`, `!`, `&`, `|`, `?`, a keyword like `return`, or at the
//   start of the file); anywhere else it is division. Python and PHP are not
//   lexed: `//` is floor division in Python, and neither has regex literals.
// - JSX children text (#1188): in `.tsx`/`.jsx` an apostrophe in prose
//   (`<p>It's</p>`) is not a quote. Read raw, it opened a phantom string that
//   suppressed a real finding after it on the line -- and, worse, flipped a
//   later quoted fixture into CODE, which DID fabricate findings. So a
//   JSX file is masked whole-source first (lib/jsx-text.mjs blanks children
//   text, keeping every offset and line break) and each line is read through
//   its masked twin (the same twin as above): `stringLiteralRanges(line, masked)` / `trimmedRanges`
//   take string literals from the twin and add the blanked JSX text as
//   rejected (data) ranges. Every other extension has no twin and reads
//   exactly as before.

import {
  hideQuotesInCommentsAndRegexes,
  QUOTE_STAND_IN,
} from '../../../lib/js-literals.mjs';
import { isJsxPath, maskJsxText } from '../../../lib/jsx-text.mjs';

/** The extensions lexed as JavaScript/TypeScript (#1192). */
const JS_FAMILY = /\.[cm]?[jt]sx?$/i;

/**
 * Compute the [start, end) index ranges of string-literal CONTENT in `line`
 * (quote characters excluded; empty literals contribute no range). With a
 * distinct masked twin `masked` (same offsets, #1188), the literals are read
 * from the twin and every run the masking blanked is added: JSX text is data,
 * not code. Without one, this is the plain per-line reading.
 * @param {string} line
 * @param {string} [masked]
 * @returns {Array<[number, number]>}
 */
export function stringLiteralRanges(line, masked = line) {
  if (masked === line) return quotedRanges(line);
  return [...quotedRanges(masked), ...blankedRuns(line, masked)];
}

/**
 * The [start, end) runs where `masked` blanked `line`. A quote stand-in
 * (#1192) is not blanking: it only stops a quote acting as a delimiter.
 */
function blankedRuns(line, masked) {
  /** @type {Array<[number, number]>} */
  const runs = [];
  let start = -1;
  for (let i = 0; i <= line.length; i += 1) {
    const blanked =
      i < line.length && masked[i] !== line[i] && masked[i] !== QUOTE_STAND_IN;
    if (blanked && start < 0) start = i;
    if (!blanked && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

/**
 * @param {string} line
 * @returns {Array<[number, number]>}
 */
function quotedRanges(line) {
  // Frames: {quote, start} while inside a string; {interp: true, depth}
  // while inside a template's ${...} (which is code and may nest strings).
  const scan = { line, ranges: [], stack: [] };
  for (let i = 0; i < line.length; i += 1) {
    const frame = scan.stack[scan.stack.length - 1];
    i = frame?.quote ? stepString(scan, frame, i) : stepCode(scan, frame, i);
  }
  // Unterminated string: treat the rest of the line as string (see header).
  // An open interpolation frame is code and stays unmarked.
  const frame = scan.stack[scan.stack.length - 1];
  if (frame?.quote) scan.ranges.push([frame.start, line.length]);
  return scan.ranges.filter(([from, to]) => to > from);
}

/** Inside a string at `i`; returns the index of the last character consumed. */
function stepString(scan, frame, i) {
  const ch = scan.line[i];
  if (ch === '\\') return i + 1; // escaped char is content, never a closer
  if (ch === frame.quote) {
    scan.ranges.push([frame.start, i]);
    scan.stack.pop();
  } else if (frame.quote === '`' && ch === '$' && scan.line[i + 1] === '{') {
    // Interpolation is code: close the string segment before `${`.
    scan.ranges.push([frame.start, i]);
    scan.stack.push({ interp: true, depth: 0 });
    return i + 1;
  }
  return i;
}

/** Code context at `i`: top-level, or inside `${ ... }`. */
function stepCode(scan, frame, i) {
  const ch = scan.line[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    scan.stack.push({ quote: ch, start: i + 1 });
  } else if (frame?.interp && ch === '{') {
    frame.depth += 1;
  } else if (frame?.interp && ch === '}') {
    closeBrace(scan, frame, i);
  }
  return i;
}

function closeBrace(scan, frame, i) {
  if (frame.depth > 0) {
    frame.depth -= 1;
    return;
  }
  scan.stack.pop();
  scan.stack[scan.stack.length - 1].start = i + 1; // the template resumes here
}

/**
 * True when `index` falls inside any of the given content ranges.
 * @param {Array<[number, number]>} ranges
 * @param {number} index
 * @returns {boolean}
 */
export function inStringLiteral(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Like `pattern.exec(line)`, but skips matches whose start index falls
 * inside a string literal, returning the first CODE match (or null).
 * @param {RegExp} pattern
 * @param {string} line
 * @param {Array<[number, number]>} ranges precomputed for `line`
 * @returns {RegExpExecArray | null}
 */
export function execOutsideStrings(pattern, line, ranges) {
  if (ranges.length === 0) return pattern.exec(line);
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let match;
  while ((match = re.exec(line)) !== null) {
    if (!inStringLiteral(ranges, match.index)) return match;
    if (re.lastIndex === match.index) re.lastIndex += 1; // zero-width guard
  }
  return null;
}

/**
 * The source a file's lines are read through, same length and line breaks:
 * for `.tsx`/`.jsx`, JSX children text is blanked (#1188); for every
 * JS-family file, quotes inside comments and regex literals are replaced by
 * a stand-in (#1192). Any other file (Python, PHP) is `text` itself.
 * @param {string} text
 * @param {string} file
 * @returns {string}
 */
export function maskSourceForFile(text, file) {
  const read = isJsxPath(file) ? maskJsxText(text) : text;
  return JS_FAMILY.test(file) ? hideQuotesInCommentsAndRegexes(read) : read;
}

/**
 * `stringLiteralRanges` for `raw.trim()`, the view the scanners match against, with
 * the masked twin `masked` of the untrimmed `raw` aligned to it.
 * @param {string} raw
 * @param {string} [masked]
 * @returns {Array<[number, number]>}
 */
export function trimmedRanges(raw, masked = raw) {
  const stripped = raw.trim();
  const lead = raw.length - raw.trimStart().length;
  return stringLiteralRanges(
    stripped,
    masked.slice(lead, lead + stripped.length),
  );
}
