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
// This file is intentionally duplicated verbatim in canary-blackhawk and
// canary-savant: skills are self-contained by contract (their packaging
// suites forbid cross-imports), and #479 tracks extracting shared skill
// infrastructure. A parity test pins the two copies byte-identical.
//
// Fidelity limits (line-based scanner, no parser):
// - Handles '...', "...", and `...` template literals. `${...}` interpolation
//   regions are CODE (a nested-frame scan, so `${`x`}` and `${fn({a:1})}`
//   work); backslash escapes are respected; a quote of the other kind inside
//   a string is content.
// - An unterminated quote marks the REST OF THE LINE as string. That is the
//   safe default for multi-line Python strings whose opener ends mid-line,
//   and for apostrophes in trailing comments: this helper only ever REJECTS
//   matches, so the worst case is a suppressed match inside what was really
//   string-ish text -- never a new false positive.
// - Strings spanning lines (template literals, triple quotes) are only seen
//   on their opening line; continuation lines look like code. Accepted: the
//   scanners are line-based by design.
// - Regex literals containing quotes (/['"]/) can open a phantom string for
//   the rest of the line. Same rejection-only safety argument applies.

/**
 * Compute the [start, end) index ranges of string-literal CONTENT in `line`
 * (quote characters excluded; empty literals contribute no range).
 * @param {string} line
 * @returns {Array<[number, number]>}
 */
export function stringLiteralRanges(line) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  // Frames: {quote, start} while inside a string; {interp: true, depth}
  // while inside a template's ${...} (which is code and may nest strings).
  const stack = [];
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const frame = top();
    if (frame && frame.quote) {
      if (ch === '\\') {
        i += 1; // escaped char is content, never a closer
      } else if (ch === frame.quote) {
        ranges.push([frame.start, i]);
        stack.pop();
      } else if (frame.quote === '`' && ch === '$' && line[i + 1] === '{') {
        // Interpolation is code: close the string segment before `${`.
        ranges.push([frame.start, i]);
        stack.push({ interp: true, depth: 0 });
        i += 1;
      }
      continue;
    }
    // Code context: top-level, or inside `${ ... }`.
    if (ch === "'" || ch === '"' || ch === '`') {
      stack.push({ quote: ch, start: i + 1 });
    } else if (frame && frame.interp) {
      if (ch === '{') {
        frame.depth += 1;
      } else if (ch === '}') {
        if (frame.depth === 0) {
          stack.pop();
          top().start = i + 1; // the enclosing template resumes here
        } else {
          frame.depth -= 1;
        }
      }
    }
  }
  // Unterminated string: treat the rest of the line as string (see header).
  // An open interpolation frame is code and stays unmarked.
  const frame = top();
  if (frame && frame.quote) ranges.push([frame.start, line.length]);
  return ranges.filter(([start, end]) => end > start);
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
