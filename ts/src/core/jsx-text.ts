/**
 * Mask quote characters inside JSX children text (#1180).
 *
 * The string blankers in `string-literals.ts` and the static linter are state
 * machines over raw source. In JSX, children text is prose: `<p>It's {n}</p>`
 * contains an apostrophe that is not a string delimiter, but a blanker reads
 * it as one and the phantom literal swallows the following lines -- including
 * the `expect(...)` every scanner needs to see. So `.tsx`/`.jsx` source is
 * first passed through this function, which replaces ONLY the quote
 * characters found in JSX children text with spaces. Everything else, and
 * every offset and newline, is unchanged, so the blankers then run on it
 * exactly as they do on `.ts`/`.js`.
 *
 * Model (a state machine, not a parser):
 * - In code, `<` starts an element when the previous significant token puts
 *   it in expression position (`(`, `,`, `=`, `=>`, `return`, ...) and a tag
 *   name or `>` (fragment) follows. A comparison (`a < b`) or a generic
 *   (`useState<T>(`, `<T,>`) has an identifier or `,` in the way.
 * - Inside a tag, attribute strings are real strings and `{...}` is code.
 * - Inside children, quotes are text; `{` opens code and `<` a child or a
 *   closing tag.
 *
 * If any element is still open at end of input, the detection was wrong
 * somewhere, and the source is returned UNCHANGED: a misread must never be
 * worse than not modelling JSX at all.
 */

/** `.tsx`/`.jsx`: the files whose source may contain JSX. */
export function isJsxPath(path: string): boolean {
  return /\.(?:tsx|jsx)$/i.test(path);
}

type Frame =
  | { kind: 'tag'; closing: boolean }
  | { kind: 'children' }
  | { kind: 'expr'; depth: number };

const QUOTES = new Set(["'", '"', '`']);
/** Tokens after which `<` starts an expression, i.e. JSX rather than a comparison. */
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
const EXPRESSION_KEYWORDS = /(?:^|[^\w$])(?:return|yield|default)$/;

export function maskJsxTextQuotes(code: string): string {
  const out = code.split('');
  const stack: Frame[] = [];
  let i = 0;
  while (i < code.length) i = step(code, i, stack, out);
  return stack.length === 0 ? out.join('') : code;
}

function step(code: string, i: number, stack: Frame[], out: string[]): number {
  const frame = stack[stack.length - 1];
  if (frame?.kind === 'tag') return stepTag(code, i, stack, frame);
  if (frame?.kind === 'children') return stepChildren(code, i, stack, out);
  return stepCode(code, i, stack, frame);
}

/** Top-level code, or a `{...}` expression container. */
function stepCode(
  code: string,
  i: number,
  stack: Frame[],
  frame: Extract<Frame, { kind: 'expr' }> | undefined,
): number {
  const skipped = skipCommentOrString(code, i);
  if (skipped !== null) return skipped;
  const ch = code[i];
  if (frame && ch === '{') frame.depth += 1;
  if (frame && ch === '}') {
    if (frame.depth === 0) stack.pop();
    else frame.depth -= 1;
  }
  if (ch === '<' && startsElement(code, i))
    stack.push({ kind: 'tag', closing: false });
  return i + 1;
}

/** Inside `<Tag ...>` or `</Tag>`: attributes, strings and containers. */
function stepTag(
  code: string,
  i: number,
  stack: Frame[],
  frame: Extract<Frame, { kind: 'tag' }>,
): number {
  const ch = code[i];
  if (ch === '"' || ch === "'") return skipString(code, i);
  if (ch === '{') {
    stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '/' && code[i + 1] === '>') {
    stack.pop(); // a self-closing element is complete
    return i + 2;
  }
  if (ch !== '>') return i + 1;
  stack.pop();
  if (frame.closing)
    stack.pop(); // `</Tag>` ends the element's children
  else stack.push({ kind: 'children' });
  return i + 1;
}

/** Element children: quotes are prose, `{` is code, `<` a child or a close. */
function stepChildren(
  code: string,
  i: number,
  stack: Frame[],
  out: string[],
): number {
  const ch = code[i]!;
  if (ch === '{') {
    stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '<') {
    const closing = code[i + 1] === '/';
    stack.push({ kind: 'tag', closing });
    return i + (closing ? 2 : 1);
  }
  if (QUOTES.has(ch)) out[i] = ' ';
  return i + 1;
}

/** If a comment or string literal starts at `i`, the index just past it. */
function skipCommentOrString(code: string, i: number): number | null {
  if (QUOTES.has(code[i]!)) return skipString(code, i);
  if (code[i] !== '/') return null;
  if (code[i + 1] === '/') {
    const nl = code.indexOf('\n', i);
    return nl === -1 ? code.length : nl;
  }
  if (code[i + 1] === '*') {
    const close = code.indexOf('*/', i + 2);
    return close === -1 ? code.length : close + 2;
  }
  return null;
}

/** Index just past the literal opening at `i` (end of input if it never closes). */
function skipString(code: string, i: number): number {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === '\\') j += 1;
    else if (code[j] === quote) return j + 1;
  }
  return code.length;
}

/** True when the `<` at `i` opens a JSX element rather than a comparison or generic. */
function startsElement(code: string, i: number): boolean {
  return (
    /^<(?:>|[A-Za-z][\w.:-]*[\s>/{])/.test(code.slice(i, i + 64)) &&
    inExpressionPosition(code, i)
  );
}

function inExpressionPosition(code: string, i: number): boolean {
  let p = i - 1;
  while (p >= 0 && /\s/.test(code[p]!)) p -= 1;
  if (p < 0) return true;
  const prev = code[p]!;
  if (EXPRESSION_START.has(prev)) return true;
  if (prev === '>') return code[p - 1] === '='; // an arrow body: `() => <A/>`
  return EXPRESSION_KEYWORDS.test(code.slice(Math.max(0, p - 7), p + 1));
}
