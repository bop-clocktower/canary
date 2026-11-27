// escape -- the one place a value is made safe to print (#666).
//
// Every value the brief prints comes from somewhere the pipeline does not
// control: git output, file names (which may hold a newline or an ANSI escape),
// and other skills' findings, which quote source lines. A value that reaches
// Markdown, stdout or stderr without passing through here can forge a row,
// inject a heading or link, or repaint the terminal. So there is exactly one
// module, and every renderer imports it rather than escaping locally.

/** Default clamp for a printed value; long snippets are cut, never wrapped. */
export const MAX_TEXT = 200;

/** Clamp for strings inside the JSON brief, which is read by tools, not eyes. */
const MAX_JSON_TEXT = 1000;

// CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL` or `ESC ] ... ESC \`), and the
// remaining two-byte escapes (`ESC c`, `ESC 7`, ...).
const ANSI =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -~]?/g;

// C0 and C1 controls, DEL, and the Unicode line and paragraph separators. Any
// of them can end a line or move the cursor, so each becomes a single space.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Markdown metacharacters that can open emphasis, code, a link, an image, raw
// HTML, a heading, a table cell or an entity. The backslash comes first in the
// class only for readability; replacement is a single pass.
const MD_META = /[\\`*_[\]()<>|#~!&]/g;

/**
 * One plain line: escapes removed, controls flattened, length clamped by code
 * point (a surrogate pair is never split).
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clean(value, max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(ANSI, '')
    .replace(CONTROL, ' ');
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 3)).join('')}...`;
}

/**
 * `clean`, then escape Markdown metacharacters. Clamping happens first, so an
 * escape is never cut in half.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function md(value, max = MAX_TEXT) {
  return clean(value, max).replace(MD_META, '\\$&');
}

/**
 * `clean` applied to every string (keys included) in a JSON-shaped value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function cleanDeep(value) {
  if (typeof value === 'string') return clean(value, MAX_JSON_TEXT);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [clean(k), cleanDeep(v)]),
  );
}

/**
 * Escape every regex metacharacter. The pipeline builds no pattern from input
 * text today; any future one must go through here (CodeQL
 * js/incomplete-sanitization).
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
