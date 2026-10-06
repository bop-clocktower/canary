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
 * Recovery is local. A closing tag closes only the element it names (`</>`
 * only a fragment), so a misread `<` cannot be "closed" by an unrelated
 * `</b>` later in the file -- inside a string, say -- and blank every line
 * between (#1193). When a pass ends with elements still open, those `<` were
 * not JSX after all (a type-level generic such as `cb: <T>(x: T) => void`),
 * so the walk is repeated with them read as operators -- all at once, so a
 * file with many such generics needs few passes. An element whose OWN closing
 * tag was seen while a misread one blocked it (a real element with a generic
 * in an attribute) is spared while any other is left, so it keeps its
 * masking. Tag names compare with whitespace and comments dropped
 * (`</ Foo .Bar>` closes `<Foo.Bar>`). Only when no pass balances does the
 * source come back unmasked -- the same reading `.ts` gets.
 */

import {
  commentEnd,
  inExpressionPosition,
  literalEnd,
  quotedEnd,
} from './js-literals.js';

/** `.tsx`/`.jsx`: the files whose source may contain JSX. */
export function isJsxPath(path: string): boolean {
  return /\.(?:tsx|jsx)$/i.test(path);
}

type Frame =
  | {
      kind: 'tag';
      start: number;
      closing: boolean;
      angle: number;
      name: string;
      closerSeen?: boolean;
    }
  | { kind: 'children'; start: number; name: string; closerSeen?: boolean }
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

const TAG_START = /^<(?:>|[A-Za-z_$][\w$.:-]*[\s>/{<])/;
const TYPE_PARAMS =
  /^<\s*(?:const\s|[A-Za-z_$][\w$]*\s*(?:extends\b|=(?!>)|,))/;
/** One part of a tag name: `Foo`, `my-el`; joined by `.` or `:`. */
const NAME_PART = /^[A-Za-z_$][\w$-]*/;
/** Each failed pass marks at least one more `<`; beyond this, give up. */
const MAX_PASSES = 64;

/** The index of the next character at or after `i` that is not whitespace or a comment. */
function skipTrivia(code: string, i: number): number {
  let at = i;
  for (;;) {
    while (at < code.length && /\s/.test(code[at]!)) at += 1;
    const end = commentEnd(code, at);
    if (end === null) return at;
    at = end;
  }
}

/**
 * The tag name after `<` or `</` (`''` for a fragment), with whitespace and
 * comments dropped: `</ Foo .Bar>` names `Foo.Bar`.
 */
function tagName(code: string, at: number): string {
  let i = skipTrivia(code, at);
  let name = '';
  for (;;) {
    const part = NAME_PART.exec(code.slice(i, i + 256))?.[0];
    if (part === undefined) return name;
    name += part;
    const sep = skipTrivia(code, i + part.length);
    if (code[sep] !== '.' && code[sep] !== ':') return name;
    name += code[sep];
    i = skipTrivia(code, sep + 1);
  }
}

export function maskJsxText(code: string): string {
  const operators = new Set<number>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const walk = run(code, operators);
    if (walk.stack.length === 0) return walk.out.join('');
    const open = unclosedStarts(walk.stack, operators);
    if (open.length === 0) return code;
    for (const start of open) operators.add(start);
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

/**
 * Starts of the elements a failed pass left open, not yet read as operators
 * -- sparing those whose own closing tag was seen, unless none is left.
 */
function unclosedStarts(stack: Frame[], operators: Set<number>): number[] {
  const open = stack.flatMap((frame) =>
    frame.kind !== 'expr' && !operators.has(frame.start) ? [frame] : [],
  );
  const unseen = open.filter((frame) => !frame.closerSeen);
  return (unseen.length > 0 ? unseen : open).map((frame) => frame.start);
}

/** Mark the open elements named `name`: their closing tag was seen. */
function markCloserSeen(stack: Frame[], name: string): void {
  for (const frame of stack) {
    if (frame.kind === 'children' || (frame.kind === 'tag' && !frame.closing))
      if (frame.name === name) frame.closerSeen = true;
  }
}

function step(walk: Walk, i: number): number {
  const frame = walk.stack[walk.stack.length - 1];
  if (frame?.kind === 'tag') return stepTag(walk, i, frame);
  if (frame?.kind === 'children') return stepChildren(walk, i, frame);
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
    const name = tagName(code, i + 1);
    walk.stack.push({ kind: 'tag', start: i, closing: false, angle: 0, name });
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
  walk.stack.push({ kind: 'children', start: frame.start, name: frame.name });
  return i + 1;
}

/** Pop `frames` (the tag, plus the children for a closing tag) at the `>` at `gt`. */
function closeElement(walk: Walk, gt: number, frames: number): number {
  walk.stack.length -= frames;
  walk.last = gt;
  return gt + 1;
}

/** Element children: text is masked, `{` is code, `<` a child or a close. */
function stepChildren(
  walk: Walk,
  i: number,
  frame: Extract<Frame, { kind: 'children' }>,
): number {
  const { code, out } = walk;
  const ch = code[i]!;
  if (ch === '{') {
    walk.stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '<' && !walk.operators.has(i)) {
    const next = openChildTag(walk, i, frame);
    if (next !== null) return next;
  }
  if (ch !== '\n') out[i] = ' ';
  return i + 1;
}

/**
 * A child element or this element's closing tag at `i`, or null when it is a
 * closing tag for some OTHER element -- text here, so the element stays open.
 */
function openChildTag(
  walk: Walk,
  i: number,
  frame: Extract<Frame, { kind: 'children' }>,
): number | null {
  const closing = walk.code[i + 1] === '/';
  const name = tagName(walk.code, i + (closing ? 2 : 1));
  if (closing && name !== frame.name) {
    markCloserSeen(walk.stack, name);
    return null;
  }
  walk.stack.push({ kind: 'tag', start: i, closing, angle: 0, name });
  return i + (closing ? 2 : 1);
}

function startsElement(walk: Walk, i: number): boolean {
  if (walk.operators.has(i)) return false;
  const head = walk.code.slice(i, i + 80);
  if (TYPE_PARAMS.test(head) || !TAG_START.test(head)) return false;
  return inExpressionPosition(walk.code, walk.last);
}
