// BH003 toLocale* exemptions (#1636, #1659), split out of rules.mjs.
//
// A `.toLocaleString(` / `.toLocaleDateString(` / `.toLocaleTimeString(` call
// cannot read the host time zone when its receiver is a numeric literal
// (Number/BigInt formatting has no zone) or when one of its own arguments is
// an object literal pinning `timeZone` to a string literal. Everything else
// stays flagged: the scanner is line-based and has no types, so it errs toward
// a finding, never a silent exemption.

import { commentEnd, literalEnd } from '../../../lib/js-literals.mjs';

// #1636: a JS numeric literal (decimal, fraction, exponent, hex/binary/octal,
// `_` separators, BigInt `n`), as the receiver of `.toLocaleString(`: bare
// (`1e3.`, `5000..` -- the first dot is the literal's own), or parenthesised
// with an optional sign (`(5000)`, `(-5n)`), where the `(` is a grouping paren
// rather than a call (`foo(1)`, `foo?.(1)`, `make<Date>(0)`, `fn!(0)` and
// `new Date (0)` all return anything, #1659).
const NUMBER = String.raw`(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?`;
const BARE_NUMBER = new RegExp(String.raw`(?<![\w$.])${NUMBER}$`);
const GROUPED_NUMBER = new RegExp(String.raw`\(\s*[-+]?\s*${NUMBER}\s*\)$`);
// A word after which `(` opens an expression rather than a call.
const KEYWORD_BEFORE_PAREN =
  /(?:^|[^\w$])(?:return|yield|await|typeof|void|delete|case|throw|in|of|else|do)$/;

/** Whether `prefix` (the text before `.toLocaleString`) ends in a number. */
function numericReceiver(prefix) {
  if (BARE_NUMBER.test(prefix)) return true;
  const grouped = GROUPED_NUMBER.exec(prefix);
  if (grouped === null) return false;
  const before = prefix.slice(0, grouped.index).trimEnd();
  if (/[\w$]$/.test(before)) return KEYWORD_BEFORE_PAREN.test(before);
  if (/[)\].!]$/.test(before)) return false; // a call, `?.(`, or `fn!(`
  if (before.endsWith('>')) return before.endsWith('=>'); // `<T>(` vs arrow
  return true;
}

// #1659: a `timeZone` property whose value is a string literal. It is tested
// on blanked text (see blankedCallArgs), so a literal's content is spaces and
// only a quoted `'timeZone'` key keeps its text. Anything else -- `undefined`,
// `process.env.TZ`, `resolvedOptions().timeZone`, a variable, the `{ timeZone
// }` shorthand, an expression -- is, or may be, the host zone.
const ZONE_LITERAL_PROP = /^\s*(['"]?)timeZone\1\s*:\s*(['"`])\s*\2\s*$/;

/** Same-length stand-in for a comment or literal token (#1659). */
function blankToken(token, isComment) {
  const q = token[0];
  const closed = token.length > 1 && token.endsWith(q);
  const plain = q === '`' ? !token.includes('${') : q === "'" || q === '"';
  if (isComment || !plain || !closed) return ' '.repeat(token.length);
  const body = token.slice(1, -1);
  return q + (body === 'timeZone' ? body : ' '.repeat(body.length)) + q;
}

/**
 * The argument text of the call whose `(` ends just before `start`, with
 * comments and regex literals blanked and string contents blanked (quotes
 * kept), or null when the call does not close on this line (the scanner is
 * line-based). Lexed with the shared JS lexer, so a quote inside a comment
 * or a regex cannot unbalance the scan (#1659).
 */
function blankedCallArgs(line, start) {
  const rest = line.slice(start);
  let out = '';
  let depth = 1;
  let last = -1; // the last significant character, for regex-vs-division
  for (let i = 0; i < rest.length;) {
    const comment = commentEnd(rest, i);
    const end = comment ?? literalEnd(rest, i, last);
    if (end !== null) {
      out += blankToken(rest.slice(i, end), comment !== null);
      if (comment === null) last = end - 1;
      i = end;
      continue;
    }
    const ch = rest[i];
    if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return out;
    if (!/\s/.test(ch)) last = i;
    out += ch;
    i += 1;
  }
  return null;
}

/** Split `text` on top-level commas (strings are already blanked). */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * True when one of the call's own arguments is an object literal with a
 * top-level `timeZone: '<literal>'` property. A pin nested in another call,
 * a ternary branch or an inner object does not count.
 */
function pinsLiteralZone(args) {
  return topLevelParts(args).some((arg) => {
    const object = arg.trim();
    if (!object.startsWith('{') || !object.endsWith('}')) return false;
    const body = object.slice(1, -1);
    // `{ a } || { b }` starts and ends with braces but is not one object.
    if (closesUnopened(body)) return false;
    return topLevelParts(body).some((p) => ZONE_LITERAL_PROP.test(p));
  });
}

/** Whether `text` closes a bracket it never opened. */
function closesUnopened(text) {
  let depth = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch) && (depth -= 1) < 0) return true;
  }
  return false;
}

/**
 * A `.toLocale*(` call that cannot read the host zone: Number/BigInt
 * `toLocaleString` on a numeric literal, or any of the three with a
 * string-literal `timeZone` option in its own arguments. A pinned locale
 * alone is not enough.
 */
export function localeCallIsPinned(line, m) {
  if (!m[0].startsWith('.toLocale')) return false; // strftime('%Z')
  const numeric =
    m[0].startsWith('.toLocaleString') &&
    numericReceiver(line.slice(0, m.index));
  if (numeric) return true;
  const args = blankedCallArgs(line, m.index + m[0].length);
  return args !== null && pinsLiteralZone(args);
}
