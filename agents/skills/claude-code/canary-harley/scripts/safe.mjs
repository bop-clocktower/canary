/**
 * canary-harley -- text that is safe to print into markdown an agent reads.
 *
 * A proposal carries text taken from the analysed file (type text), from its
 * path and from the command line (`--function`). Printed as it is, a newline
 * followed by a heading or an instruction would read as part of the report.
 * `safe` makes one value inert: one line, no backticks, no block marker at
 * its start, and a bounded length. `safeView` applies it to every string in
 * a value, so a field added to the proposal later cannot skip it.
 */

// C0 and C1 controls, DEL, zero-width and bidi controls, the Unicode line and
// paragraph separators and the byte-order mark, with any space around them.
const BREAK =
  /[\s\u200b-\u200f\u2060-\u2069\ufeff]*[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff][\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]*/g;

// A character that opens a block when it starts a line: a heading, a quote,
// a list item, a table row or a tilde fence. (A backtick fence cannot occur:
// backticks are replaced first.)
const MARKER = /^(?:[#>|*+-]|~~~)/;

// `12.` or `3)` followed by a space opens a numbered list.
const NUMBERED = /^(\d+)([.)])(?=\s|$)/;

const DEFAULT_MAX = 200;
const TRUNCATED = ' ...[truncated]';

/**
 * @param {string} text a value that may hold text from outside this tool
 * @param {number} [max] the longest value printed before it is cut
 * @returns {string} the value on one line, with no markup of its own
 */
export function safe(text, max = DEFAULT_MAX) {
  const flat = String(text)
    .replace(BREAK, ' ')
    .trim()
    .replace(/`/g, "'")
    .replace(MARKER, '\\$&')
    .replace(NUMBERED, '$1\\$2');
  return flat.length > max ? `${flat.slice(0, max)}${TRUNCATED}` : flat;
}

/**
 * @param {unknown} value a proposal, or any part of one
 * @returns {unknown} the same shape with every string passed through `safe`
 */
export function safeView(value) {
  if (typeof value === 'string') return safe(value);
  if (Array.isArray(value)) return value.map(safeView);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, safeView(item)]),
  );
}
