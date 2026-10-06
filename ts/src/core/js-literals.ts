/**
 * Just enough JavaScript lexing to step over comments and literals (#1180).
 *
 * Shared by the JSX masker (`jsx-text.ts`) and the string blanker
 * (`string-literals.ts`): a quote inside a comment, a template or a regex
 * literal (`/you don't/i`) must never be read as a string delimiter, and a
 * `/` or `<` means different things after a value than where an expression
 * may start. A lexer, not a parser: it decides from the previous significant
 * character only.
 */

const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|yield|default|await|case|throw|typeof|void|delete|in|of|new)$/;

/** Tokens after which an expression starts: JSX or a regex, never a comparison or division. */
const EXPRESSION_START = new Set([
  '(',
  ',',
  '=',
  ':',
  '?',
  '[',
  '{',
  ';',
  '!',
  '&',
  '|',
]);

/** Whether an expression may start after the significant character at `last`. */
export function inExpressionPosition(code: string, last: number): boolean {
  if (last < 0) return true;
  const prev = code[last]!;
  if (EXPRESSION_START.has(prev)) return true;
  if (prev === '>') return code[last - 1] === '='; // an arrow body: `() => <A/>`
  return KEYWORD_BEFORE.test(code.slice(Math.max(0, last - 9), last + 1));
}

/** If a comment starts at `i`, the index just past it. */
export function commentEnd(code: string, i: number): number | null {
  if (code[i] !== '/') return null;
  if (code[i + 1] === '/') {
    const nl = code.indexOf('\n', i);
    return nl === -1 ? code.length : nl;
  }
  if (code[i + 1] !== '*') return null;
  const close = code.indexOf('*/', i + 2);
  return close === -1 ? code.length : close + 2;
}

/**
 * If a string, template or regex literal starts at `i` (with `last` the
 * previous significant character), the index just past it.
 */
export function literalEnd(
  code: string,
  i: number,
  last: number,
): number | null {
  const ch = code[i];
  if (ch === '"' || ch === "'") return quotedEnd(code, i);
  if (ch === '`') return templateEnd(code, i);
  if (ch === '/' && inExpressionPosition(code, last)) return regexEnd(code, i);
  return null;
}

/** A quoted string ends at its quote, or at a newline it cannot legally cross. */
export function quotedEnd(code: string, i: number): number {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === '\\') j += 1;
    else if (code[j] === quote) return j + 1;
    else if (code[j] === '\n') return j;
  }
  return code.length;
}

function templateEnd(code: string, i: number): number {
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === '\\') j += 1;
    else if (code[j] === '`') return j + 1;
    else if (code[j] === '$' && code[j + 1] === '{')
      j = interpolationEnd(code, j + 2) - 1;
  }
  return code.length;
}

/** The index just past the `}` closing a `${` whose body starts at `i`. */
function interpolationEnd(code: string, i: number): number {
  let depth = 0;
  let last = i - 1;
  for (let j = i; j < code.length; j += 1) {
    const c = code[j]!;
    if (/\s/.test(c)) continue;
    const skipped = commentEnd(code, j) ?? literalEnd(code, j, last);
    if (skipped !== null) {
      j = skipped - 1;
    } else if (c === '}' && depth === 0) {
      return j + 1;
    } else if (c === '{' || c === '}') {
      depth += c === '{' ? 1 : -1;
    }
    last = j;
  }
  return code.length;
}

/** A regex literal: to the next unescaped `/` outside a class, on one line. */
function regexEnd(code: string, i: number): number | null {
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

/**
 * If a regex literal starts at `i`, the index just past it. For a caller with
 * no token tracking: the previous significant character is found by walking
 * back over whitespace.
 */
export function regexLiteralEnd(code: string, i: number): number | null {
  if (code[i] !== '/' || code[i + 1] === '/' || code[i + 1] === '*')
    return null;
  let p = i - 1;
  while (p >= 0 && /\s/.test(code[p]!)) p -= 1;
  return inExpressionPosition(code, p) ? regexEnd(code, i) : null;
}
