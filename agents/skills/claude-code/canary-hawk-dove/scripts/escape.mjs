// escape -- the one place canary-hawk-dove makes a value safe to print (#618).
//
// Ledger rows, gate JSON, git output and file names are all outside this
// skill's control. A value that reaches Markdown, stdout or stderr without
// passing through here could forge a table row, open a link, autolink a URL a
// reader then clicks, or repaint the terminal. Every renderer imports this
// module; none escapes locally.

/** Default clamp for a printed value. */
export const MAX_TEXT = 200;

// CSI, OSC (BEL- or ST-terminated) and the remaining two-byte escapes.
const ANSI =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -~]?/g;

// C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Metacharacters that open emphasis, code, a link, raw HTML, a heading, a
// table cell or an entity. `(` only forms a link after `]`, which is escaped.
const MD_META = /[\\`*_[\]<>|#~!&]/g;

// GFM's autolink extension links `scheme://`, `www.` and `user@host` without
// any Markdown syntax, so escaping metacharacters alone leaves them live. A
// zero-width space inside each trigger is accepted by no autolink scanner.
const ZWSP = '\u200b';
const AUTOLINK = /:\/\/|\bwww\.|@/gi;

function breakAutolink(match) {
  if (match === '://') return `:/${ZWSP}/`;
  if (match === '@') return `${ZWSP}@`;
  return `${match.slice(0, 3)}${ZWSP}.`;
}

/**
 * One plain line: escapes removed, controls flattened, clamped by code point.
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
 * `clean`, then Markdown metacharacters escaped and autolinks broken.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function md(value, max = MAX_TEXT) {
  return clean(value, max)
    .replace(MD_META, '\\$&')
    .replace(AUTOLINK, breakAutolink);
}
