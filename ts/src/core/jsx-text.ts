/**
 * Mask JSX children text before the string blankers and rule regexes run
 * (#1180).
 *
 * The blankers in `string-literals.ts` and the static linter read raw source.
 * In JSX, children text is prose, and prose broke them two ways: an
 * apostrophe (`<p>It's {n}</p>`) opened a phantom string that swallowed the
 * following lines -- including the `expect(...)` every scanner needs -- and
 * plain English matched rules ("...as you should." read as an assertion,
 * "timeout is 45 minutes" as a magic timing value). So `.tsx`/`.jsx` source
 * is first passed through `maskJsxText`, which replaces every non-newline
 * character of JSX children text with a space. Tags, attributes and `{...}`
 * expression containers are untouched, and so is every offset and newline.
 *
 * Model (a lexer, not a parser):
 * - In code, `<` starts an element when the previous significant token puts
 *   it in expression position (`(`, `,`, `=`, `=>`, `return`, ...) and a tag
 *   name or `>` (fragment) follows. A comparison (`a < b`) or a generic call
 *   (`useState<T>(`) has an identifier in the way; type parameters
 *   (`<T extends X>`, `<T = X>`, `<A, B>`, `<const T>`) are recognised.
 *   Comments, string/template/regex literals are skipped, so a quote inside
 *   one cannot derail the walk and a comment cannot hide the previous token.
 * - Inside a tag, attribute strings are strings, `{...}` is code, comments
 *   are comments, and `<...>` after the name is type arguments.
 * - Inside children, text is masked; `{` opens code and `<` a child or a
 *   closing tag.
 *
 * Recovery is local. When a pass ends with an element still open, the
 * innermost unclosed `<` was not JSX after all (a type-level generic such as
 * `cb: <T>(x: T) => void`), so the walk is repeated with that one `<` read as
 * an operator. Only when no pass balances does the source come back
 * unmasked -- the same reading `.ts` gets.
 */

/** `.tsx`/`.jsx`: the files whose source may contain JSX. */
export function isJsxPath(path: string): boolean {
  return /\.(?:tsx|jsx)$/i.test(path);
}

type Frame =
  | { kind: 'tag'; start: number; closing: boolean; angle: number }
  | { kind: 'children'; start: number }
  | { kind: 'expr'; depth: number };

interface Walk {
  code: string;
  out: string[];
  stack: Frame[];
  /** `<` offsets that earlier passes proved are not JSX. */
  operators: Set<number>;
  /** Offset of the last significant code character (whitespace and comments skipped). */
  last: number;
}

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
const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|yield|default|await|case|throw|typeof|void|delete|in|of|new)$/;
const TAG_START = /^<(?:>|[A-Za-z_$][\w$.:-]*[\s>/{<])/;
const TYPE_PARAMS =
  /^<\s*(?:const\s|[A-Za-z_$][\w$]*\s*(?:extends\b|=(?!>)|,))/;
/** One pass per `<` that can turn out not to close; beyond this, give up. */
const MAX_PASSES = 64;

export function maskJsxText(code: string): string {
  const operators = new Set<number>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const walk = run(code, operators);
    if (walk.stack.length === 0) return walk.out.join('');
    const open = innermostElementStart(walk.stack);
    if (open === null || operators.has(open)) return code;
    operators.add(open);
  }
  return code;
}

function run(code: string, operators: Set<number>): Walk {
  const walk: Walk = {
    code,
    out: code.split(''),
    stack: [],
    operators,
    last: -1,
  };
  let i = 0;
  while (i < code.length) i = step(walk, i);
  return walk;
}

function innermostElementStart(stack: Frame[]): number | null {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const frame = stack[k]!;
    if (frame.kind !== 'expr') return frame.start;
  }
  return null;
}

function step(walk: Walk, i: number): number {
  const frame = walk.stack[walk.stack.length - 1];
  if (frame?.kind === 'tag') return stepTag(walk, i, frame);
  if (frame?.kind === 'children') return stepChildren(walk, i);
  return stepCode(walk, i, frame);
}

/** Top-level code, or a `{...}` expression container. */
function stepCode(
  walk: Walk,
  i: number,
  frame: Extract<Frame, { kind: 'expr' }> | undefined,
): number {
  const { code } = walk;
  const ch = code[i]!;
  if (/\s/.test(ch)) return i + 1;
  const comment = commentEnd(code, i);
  if (comment !== null) return comment;
  const literal = literalEnd(code, i, walk.last);
  if (literal !== null) {
    walk.last = literal - 1;
    return literal;
  }
  if (ch === '<' && startsElement(walk, i)) {
    walk.stack.push({ kind: 'tag', start: i, closing: false, angle: 0 });
    return i + 1;
  }
  if (frame) trackBraces(walk, frame, ch);
  walk.last = i;
  return i + 1;
}

function trackBraces(
  walk: Walk,
  frame: Extract<Frame, { kind: 'expr' }>,
  ch: string,
): void {
  if (ch === '{') frame.depth += 1;
  if (ch !== '}') return;
  if (frame.depth === 0) walk.stack.pop();
  else frame.depth -= 1;
}

/** Inside `<Tag ...>` or `</Tag>`. */
function stepTag(
  walk: Walk,
  i: number,
  frame: Extract<Frame, { kind: 'tag' }>,
): number {
  const { code } = walk;
  const ch = code[i]!;
  const comment = commentEnd(code, i);
  if (comment !== null) return comment;
  if (ch === '"' || ch === "'") return quotedEnd(code, i);
  if (ch === '{') {
    walk.stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '<' || (ch === '>' && frame.angle > 0)) {
    frame.angle += ch === '<' ? 1 : -1; // `<Select<Opt>`: type arguments
    return i + 1;
  }
  if (ch === '/' && code[i + 1] === '>') return closeElement(walk, i + 1, 1);
  if (ch !== '>') return i + 1;
  if (frame.closing) return closeElement(walk, i, 2);
  walk.stack.pop();
  walk.stack.push({ kind: 'children', start: frame.start });
  return i + 1;
}

/** Pop `frames` (the tag, plus the children for a closing tag) at the `>` at `gt`. */
function closeElement(walk: Walk, gt: number, frames: number): number {
  walk.stack.length -= frames;
  walk.last = gt;
  return gt + 1;
}

/** Element children: text is masked, `{` is code, `<` a child or a close. */
function stepChildren(walk: Walk, i: number): number {
  const { code, out } = walk;
  const ch = code[i]!;
  if (ch === '{') {
    walk.stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '<' && !walk.operators.has(i)) {
    const closing = code[i + 1] === '/';
    walk.stack.push({ kind: 'tag', start: i, closing, angle: 0 });
    return i + (closing ? 2 : 1);
  }
  if (ch !== '\n') out[i] = ' ';
  return i + 1;
}

function startsElement(walk: Walk, i: number): boolean {
  if (walk.operators.has(i)) return false;
  const head = walk.code.slice(i, i + 80);
  if (TYPE_PARAMS.test(head) || !TAG_START.test(head)) return false;
  return inExpressionPosition(walk.code, walk.last);
}

/** Whether an expression may start after the significant character at `last`. */
function inExpressionPosition(code: string, last: number): boolean {
  if (last < 0) return true;
  const prev = code[last]!;
  if (EXPRESSION_START.has(prev)) return true;
  if (prev === '>') return code[last - 1] === '='; // an arrow body: `() => <A/>`
  return KEYWORD_BEFORE.test(code.slice(Math.max(0, last - 9), last + 1));
}

/** If a comment starts at `i`, the index just past it. */
function commentEnd(code: string, i: number): number | null {
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
function literalEnd(code: string, i: number, last: number): number | null {
  const ch = code[i];
  if (ch === '"' || ch === "'") return quotedEnd(code, i);
  if (ch === '`') return templateEnd(code, i);
  if (ch === '/' && inExpressionPosition(code, last)) return regexEnd(code, i);
  return null;
}

/** A quoted string ends at its quote, or at a newline it cannot legally cross. */
function quotedEnd(code: string, i: number): number {
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
