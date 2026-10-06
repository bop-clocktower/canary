// Mask JSX children text for the line-based skill scanners (#1188).
//
// canary-blackhawk and canary-savant read each line through a per-line
// string-literal helper (string-literals.mjs). In JSX, children text is
// prose, and an apostrophe in it (`<p>It's {n}</p>`) opened a phantom string
// for the rest of the line: a real finding after it was suppressed, and a
// quoted fixture after it read as code -- a fabricated finding. So a
// `.tsx`/`.jsx` source is first passed through `maskJsxText`, which replaces
// every character of JSX children text with a space. Tags, attributes,
// `{...}` expression containers, every offset and every line break (`\r`
// included, so a CRLF file splits into the same lines) are untouched.
//
// A self-contained port of the engine's ts/src/core/jsx-text.ts and
// js-literals.ts (#1180/#1190): skills run without the engine, so this file
// stays standard-library-free and ascii-only. Keep the two in step.
//
// Model (a lexer, not a parser):
// - In code, `<` starts an element when the previous significant token puts
//   it in expression position (`(`, `,`, `=`, `=>`, `return`, ...) and a tag
//   name or `>` (fragment) follows. A comparison (`a < b`) or a generic call
//   (`useState<T>(`) has an identifier in the way; type parameters
//   (`<T extends X>`, `<T = X>`, `<A, B>`, `<const T>`) are recognised.
//   Comments and string/template/regex literals are skipped, so a quote in
//   one cannot derail the walk and a comment cannot hide the previous token.
// - Inside a tag, attribute strings are strings, `{...}` is code, comments
//   are comments, and `<...>` after the name is type arguments.
// - Inside children, text is masked; `{` opens code and `<` a child or a
//   closing tag.
//
// Recovery is local. A closing tag closes only the element it names (`</>`
// only a fragment), so a misread `<` cannot be "closed" by an unrelated
// `</b>` later in the file -- inside a string, say -- and blank every line
// between (#1193). When a pass ends with elements still open, those `<` were
// not JSX after all (a type-level generic such as `cb: <T>(x: T) => void`),
// so the walk is repeated with every one of them read as an operator: all at
// once, so a file with many such generics needs few passes. The cost is that
// a real element enclosing a misread one is read as code too -- the `.ts`
// reading, never a blanked line. Only when no pass balances does the source
// come back unmasked -- the same reading a `.ts` file gets.

const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|yield|default|await|case|throw|typeof|void|delete|in|of|new)$/;

/** Tokens after which an expression starts: JSX or a regex, never a comparison or division. */
const EXPRESSION_START = new Set('(,=:?[{;!&|'.split(''));

const TAG_START = /^<(?:>|[A-Za-z_$][\w$.:-]*[\s>/{<])/;
const TYPE_PARAMS =
  /^<\s*(?:const\s|[A-Za-z_$][\w$]*\s*(?:extends\b|=(?!>)|,))/;
/** The tag name after `<` or `</` (`''` for a fragment). */
const TAG_NAME = /^\s*([A-Za-z_$][\w$.:-]*)?/;
/** Each failed pass marks at least one more `<`; beyond this, give up. */
const MAX_PASSES = 64;

function tagName(code, at) {
  return TAG_NAME.exec(code.slice(at, at + 80))?.[1] ?? '';
}

/**
 * `.tsx`/`.jsx`: the files whose source may contain JSX.
 * @param {string} file
 * @returns {boolean}
 */
export function isJsxPath(file) {
  return /\.(?:tsx|jsx)$/i.test(file);
}

/** Whether an expression may start after the significant character at `last`. */
function inExpressionPosition(code, last) {
  if (last < 0) return true;
  const prev = code[last];
  if (EXPRESSION_START.has(prev)) return true;
  if (prev === '>') return code[last - 1] === '='; // an arrow body: `() => <A/>`
  return KEYWORD_BEFORE.test(code.slice(Math.max(0, last - 9), last + 1));
}

/** If a comment starts at `i`, the index just past it; else null. */
function commentEnd(code, i) {
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
function literalEnd(code, i, last) {
  const ch = code[i];
  if (ch === '"' || ch === "'") return quotedEnd(code, i);
  if (ch === '`') return templateEnd(code, i);
  if (ch === '/' && inExpressionPosition(code, last)) return regexEnd(code, i);
  return null;
}

/** A quoted string ends at its quote, or at a newline it cannot legally cross. */
function quotedEnd(code, i) {
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

/**
 * `code` with JSX children text blanked to spaces (same length, same line
 * breaks), or `code` itself when no reading balances.
 * @param {string} code
 * @returns {string}
 */
export function maskJsxText(code) {
  const operators = new Set();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const walk = run(code, operators);
    if (walk.stack.length === 0) return walk.out.join('');
    const open = unclosedStarts(walk.stack, operators);
    if (open.length === 0) return code;
    for (const start of open) operators.add(start);
  }
  return code;
}

// Frames: {kind: 'tag', start, closing, angle, name}
//       | {kind: 'children', start, name} | {kind: 'expr', depth}. `last` is the offset of the last significant
// code character (whitespace and comments skipped).
function run(code, operators) {
  const walk = { code, out: code.split(''), stack: [], operators, last: -1 };
  let i = 0;
  while (i < code.length) i = step(walk, i);
  return walk;
}

/** Starts of the elements a failed pass left open, not yet read as operators. */
function unclosedStarts(stack, operators) {
  return stack.flatMap((frame) =>
    frame.kind !== 'expr' && !operators.has(frame.start) ? [frame.start] : [],
  );
}

function step(walk, i) {
  const frame = walk.stack[walk.stack.length - 1];
  if (frame?.kind === 'tag') return stepTag(walk, i, frame);
  if (frame?.kind === 'children') return stepChildren(walk, i, frame);
  return stepCode(walk, i, frame);
}

/** Top-level code, or a `{...}` expression container. */
function stepCode(walk, i, frame) {
  const { code } = walk;
  const ch = code[i];
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

function trackBraces(walk, frame, ch) {
  if (ch === '{') frame.depth += 1;
  if (ch !== '}') return;
  if (frame.depth === 0) walk.stack.pop();
  else frame.depth -= 1;
}

/** Inside `<Tag ...>` or `</Tag>`. */
function stepTag(walk, i, frame) {
  const { code } = walk;
  const ch = code[i];
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
  return stepTagEnd(walk, i, frame);
}

/** `/>`, `>` or any other tag character, outside type arguments. */
function stepTagEnd(walk, i, frame) {
  const { code } = walk;
  const ch = code[i];
  if (ch === '/' && code[i + 1] === '>') return closeElement(walk, i + 1, 1);
  if (ch !== '>') return i + 1;
  if (frame.closing) return closeElement(walk, i, 2);
  walk.stack.pop();
  walk.stack.push({ kind: 'children', start: frame.start, name: frame.name });
  return i + 1;
}

/** Pop `frames` (the tag, plus the children for a closing tag) at the `>` at `gt`. */
function closeElement(walk, gt, frames) {
  walk.stack.length -= frames;
  walk.last = gt;
  return gt + 1;
}

/** Element children: text is masked, `{` is code, `<` a child or a close. */
function stepChildren(walk, i, frame) {
  const { code, out } = walk;
  const ch = code[i];
  if (ch === '{') {
    walk.stack.push({ kind: 'expr', depth: 0 });
    return i + 1;
  }
  if (ch === '<' && !walk.operators.has(i)) {
    const next = openChildTag(walk, i, frame);
    if (next !== null) return next;
  }
  if (ch !== '\n' && ch !== '\r') out[i] = ' ';
  return i + 1;
}

/**
 * A child element or this element's closing tag at `i`, or null when it is a
 * closing tag for some OTHER element -- text here, so the element stays open.
 */
function openChildTag(walk, i, frame) {
  const closing = walk.code[i + 1] === '/';
  const name = tagName(walk.code, i + (closing ? 2 : 1));
  if (closing && name !== frame.name) return null;
  walk.stack.push({ kind: 'tag', start: i, closing, angle: 0, name });
  return i + (closing ? 2 : 1);
}

function startsElement(walk, i) {
  if (walk.operators.has(i)) return false;
  const head = walk.code.slice(i, i + 80);
  if (TYPE_PARAMS.test(head) || !TAG_START.test(head)) return false;
  return inExpressionPosition(walk.code, walk.last);
}
