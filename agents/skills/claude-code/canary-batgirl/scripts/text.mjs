// text -- the one escaping helper canary-batgirl routes every input value
// through (spec D10).
//
// Paths, parse errors (which quote file content), branch names and any other
// value read from an input are text a hostile branch controls. Before any of it
// reaches Markdown, JSON values, stdout or stderr it passes through `plain`
// (JSON, terminal) or `md` (Markdown), so a value can never add a report line,
// emit a terminal escape, forge a table cell or a link, or flood the output.
// JSON keys are never derived from input, so no key can collide after
// cleaning: every key batgirl prints is one of its own constants.
//
// Source stays ASCII: every special character is written as an escape.

/** Default clamp, in code points. */
export const MAX_TEXT = 200;

// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \), then any other
// two-byte ESC sequence.
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;

// C0, DEL, C1, Unicode line/paragraph separators and bidi controls.
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Markdown metacharacters that can start emphasis, code, links, headings,
// HTML, tables or entities mid-line. batgirl never starts a line with a value.
const MD_META = /[\\`*_[\]()#+!|<>~{}&]/g;

function clamp(text, max) {
  const points = [...text];
  if (points.length <= max) return text;
  return points.slice(0, Math.max(0, max - 3)).join('') + '...';
}

/**
 * One line of inert text: no escape sequence, no control character, no line
 * break, at most `max` code points.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function plain(value, max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(ANSI, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clamp(text, max);
}

// GFM extended autolinks need no Markdown metacharacter at all: a scheme URL
// (`https://`), a `www.` host, or a bare email turns into a live link on its
// own. Each trigger is defanged with escaped brackets, the convention security
// reports use (`https[:]//`, `www[.]`, `a[@]b`), so the value still reads but
// no longer links.
const AUTOLINKS = [
  [/:\/\//g, '\\[:\\]//'],
  [/\b(www)\./gi, '$1\\[.\\]'],
  [/@/g, '\\[@\\]'],
];

/**
 * `plain`, then Markdown-escaped and autolink-defanged, for any value that
 * lands in Markdown.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function md(value, max = MAX_TEXT) {
  let text = plain(value, max).replace(MD_META, '\\$&');
  for (const [trigger, defanged] of AUTOLINKS) {
    text = text.replace(trigger, defanged);
  }
  return text;
}
