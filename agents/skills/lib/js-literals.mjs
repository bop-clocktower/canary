// Just enough JavaScript lexing to step over comments and literals (#1188).
//
// A self-contained port of the engine's ts/src/core/js-literals.ts, used by
// the skills' JSX masker (jsx-text.mjs): a quote inside a comment, a template
// or a regex literal (`/you don't/i`) must never be read as a string
// delimiter, and a `/` or `<` means different things after a value than where
// an expression may start. A lexer, not a parser: it decides from the
// previous significant character only. Standard library only, ascii-only;
// ts/test/jsx-mask-conformance.test.ts holds it to the engine's reading.

const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|yield|default|await|case|throw|typeof|void|delete|in|of|new)$/;

/** Tokens after which an expression starts: JSX or a regex, never a comparison or division. */
const EXPRESSION_START = new Set('(,=:?[{;!&|'.split(''));

/** Whether an expression may start after the significant character at `last`. */
export function inExpressionPosition(code, last) {
  if (last < 0) return true;
  const prev = code[last];
  if (EXPRESSION_START.has(prev)) return true;
  if (prev === '>') return code[last - 1] === '='; // an arrow body: `() => <A/>`
  return KEYWORD_BEFORE.test(code.slice(Math.max(0, last - 9), last + 1));
}

/** If a comment starts at `i`, the index just past it; else null. */
export function commentEnd(code, i) {
  if (code[i] !== '/') return null;
  if (code[i + 1] === '/') {
    const nl = code.indexOf('\n', i);
    return nl === -1 ? code.length : nl;
  }
  if (code[i + 1] !== '*') return null;
  const close = code.indexOf('*/', i + 2);
  return close === -1 ? code.length : close + 2;
}

/** If a string, template or regex literal starts at `i`, the index just past it. */
export function literalEnd(code, i, last) {
  const ch = code[i];
  if (ch === '"' || ch === "'") return quotedEnd(code, i);
  if (ch === '`') return templateEnd(code, i);
  if (ch === '/' && inExpressionPosition(code, last)) return regexEnd(code, i);
  return null;
}

/** A quoted string ends at its quote, or at a newline it cannot legally cross. */
export function quotedEnd(code, i) {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === '\\') j += 1;
    else if (code[j] === quote) return j + 1;
    else if (code[j] === '\n') return j;
  }
  return code.length;
}

function templateEnd(code, i) {
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === '\\') j += 1;
    else if (code[j] === '`') return j + 1;
    else if (code[j] === '$' && code[j + 1] === '{')
      j = interpolationEnd(code, j + 2) - 1;
  }
  return code.length;
}

/** The index just past the `}` closing a `${` whose body starts at `i`. */
function interpolationEnd(code, i) {
  let depth = 0;
  let last = i - 1;
  for (let j = i; j < code.length; j += 1) {
    if (/\s/.test(code[j])) continue;
    const skipped = commentEnd(code, j) ?? literalEnd(code, j, last);
    if (skipped !== null) {
      j = skipped - 1;
    } else if (code[j] === '}') {
      if (depth === 0) return j + 1;
      depth -= 1;
    } else if (code[j] === '{') {
      depth += 1;
    }
    last = j;
  }
  return code.length;
}

/** A regex literal: to the next unescaped `/` outside a class, on one line. */
function regexEnd(code, i) {
  let inClass = false;
  for (let j = i + 1; j < code.length; j += 1) {
    const c = code[j];
    if (c === '\\') j += 1;
    else if (c === '\n') return null;
    else if (c === '[' || c === ']') inClass = c === '[';
    else if (c === '/' && !inClass) return j + 1;
  }
  return null;
}
