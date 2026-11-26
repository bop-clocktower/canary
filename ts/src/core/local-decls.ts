/**
 * Same-file declarations in a test file: the names each binds and the text it
 * owns (#1751).
 *
 * Extracted verbatim from the vacuity scanner, which uses it to follow a test
 * through a one-level helper to its target (#1170). The static linter needs
 * the same answer for LINT-006 -- a test whose only statement calls a helper
 * that asserts is not assertion-free -- and the linter cannot import the
 * scanner, which already imports the linter. One parser keeps the two from
 * disagreeing about where a helper's body ends.
 *
 * Every function here reads STRING-BLANKED code (see `blankStringContent`),
 * so a declaration written inside a fixture string is never seen.
 */

/**
 * A local declaration whose body may reach the target set.
 *
 * Three shapes, and the third is not optional. Measured on canary's own suite,
 * the largest single source of false positives was the testkit idiom
 * `const { findings, write } = kitFor(dir)`: the imported target is `kitFor`,
 * `findings()` reaches it, and a pattern that only understood `const x = ` saw
 * none of it -- so every test in `doc-links.test.ts` read as touching nothing at
 * all. An object pattern binds every name in it to the same reaching RHS.
 *
 * A type annotation may sit between the binding and its `=` (#1179):
 * `const parse: Parser = (...a) => parseArgv(a)` was invisible, so a test
 * calling the target through it drew VAC-002. The annotation is one line with no
 * `=` or `;` of its own -- except the `=>` of a function type, which is why the
 * declaration's `=` must not be followed by `>`. A multi-line annotation, or an
 * object type with `;` members, is still missed: the safe direction, because a
 * missed declaration can only leave a finding standing, never silence one.
 *
 * The leading indent is `[^\S\n]*`, not `\s*`, here and in every
 * `(?:^|\n)`-anchored pattern in this file. These run over BLANKED source, where
 * a big multi-line fixture is a long run of spaces and newlines, and `\s*`
 * restarted at every newline in it and re-consumed the rest of the run --
 * quadratic, ~23s on a 16,000-line fixture. The match set is unchanged: a
 * declaration after blank lines is still found from the last newline.
 */
const JS_LOCAL_DECL =
  /(?:^|\n)[^\S\n]*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(?:\{([^}]*)\}|\[([^\]]*)\]|(\w+))(?:\s*:(?:[^=;\n]|=>)+?)?\s*=(?![=>]))/g;
const PY_LOCAL_DECL = /(?:^|\n)[^\S\n]*def\s+(\w+)\s*\(/g;

/**
 * A destructuring ASSIGNMENT with no declarator: `({ write, findings } =
 * kitFor(root))`.
 *
 * The declare-then-assign-in-a-hook idiom -- `let findings: Kit['findings']` at
 * module scope, bound inside `beforeEach`. `doc-links.test.ts` is written this
 * way throughout, and because the binding line carries no `const`/`let`/`var`,
 * a declaration-only pattern misses it and every test in the file reads as
 * touching nothing at all.
 */
const JS_DESTRUCTURED_ASSIGN = /\(\s*\{([^}]*)\}\s*=\s*([^;\n]*)\)/g;

/** Every identifier bound by one declaration match (a pattern binds several). */
function boundNames(m: RegExpMatchArray, python: boolean): string[] {
  if (python) return m[1] ? [m[1]] : [];
  if (m[1]) return [m[1]];
  if (m[4]) return [m[4]];
  const pattern = m[2] ?? m[3] ?? '';
  return pattern
    .split(',')
    .map((raw) =>
      raw
        .split(':')
        .pop()!
        .trim()
        .replace(/^\.\.\./, ''),
    )
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/**
 * Brace depth immediately BEFORE each character, over already-blanked code.
 *
 * Cheap and approximate on purpose: string content is blanked before this runs,
 * so the only braces it can see are real ones (a `{` inside a comment is the
 * residual inaccuracy, and it can only widen a body, never narrow one).
 */
function braceDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length);
  let d = 0;
  for (let i = 0; i < code.length; i += 1) {
    depths[i] = d;
    const c = code[i];
    if (c === '{') d += 1;
    else if (c === '}') d -= 1;
  }
  return depths;
}

/**
 * Where declaration `i`'s body ends.
 *
 * Bounding it at the NEXT declaration is wrong for any helper that declares
 * something inside itself, and that is the common shape for the subprocess
 * helper #705 is about:
 *
 * ```ts
 * const SCRIPT = join(REPO_ROOT, 'scripts', 'entropy-ratchet.mjs');
 * function run() {
 *   const r = spawnSync(process.execPath, [SCRIPT, ...]);   // <- next decl
 *   ...
 * }
 * ```
 *
 * `run`'s body stopped at `const r`, so it never saw `SCRIPT`, so `run()` did
 * not reach the target and every test calling it read as vacuous. Nesting is the
 * discriminator: the body runs to the next declaration at the same or shallower
 * brace depth, which is the first one that is genuinely a SIBLING.
 */
function declEnd(
  code: string,
  matches: RegExpMatchArray[],
  i: number,
  depth: Int32Array | null,
): number {
  if (depth === null) return matches[i + 1]?.index ?? code.length;
  const m = matches[i]!;
  const own = depth[m.index!] ?? 0;
  let sibling = code.length;
  for (let j = i + 1; j < matches.length; j += 1) {
    const at = matches[j]!.index!;
    if ((depth[at] ?? 0) <= own) {
      sibling = at;
      break;
    }
  }
  const from = m.index! + m[0].length;
  // A `function` owns its own braced body. Running it to the next sibling
  // instead let a helper that never touches the target absorb a TEST below it
  // that does, so a test calling only that helper read as invoking the target
  // and the real VAC-002 went quiet (#1170's surviving positive).
  if (m[1]) return Math.min(functionBodyEnd(code, from, depth), sibling);
  // A `const`/`let`/`var` owns only its initializer (#871): inside a test body
  // there is usually no later sibling, so bounding a bystander at one let it
  // absorb the target call below it and read as reaching the target, silencing
  // VAC-003. The statement ends at the first `;` or line break at the
  // declaration's own brace depth, so an arrow helper's braced body still
  // belongs to it -- unless the line plainly continues (#1170): an open paren
  // or bracket, a trailing `=>`/operator, or a next line starting with `.`.
  // Prettier wraps `const parse = (...a) =>\n  target(a)` exactly that way.
  let parens = 0;
  for (let k = from; k < sibling; k += 1) {
    const ch = code[k];
    if (ch === '(' || ch === '[') parens += 1;
    else if (ch === ')' || ch === ']') parens -= 1;
    if (parens > 0 || (depth[k] ?? 0) > own) continue;
    if (ch === ';') return k;
    if (ch === '\n' && !continuesPastNewline(code, k)) return k;
  }
  return sibling;
}

/** Characters that leave an expression incomplete at the end of a line. */
const TRAILING_CONTINUATION = /(?:=>|[=,(?:|&+\-*/.[{])\s*$/;
/** Characters that attach a line to the expression above it. */
const LEADING_CONTINUATION = /^\s*(?:[.?:|&)\]]|=>)/;

/** Does the statement around the line break at `nl` carry on past it? */
function continuesPastNewline(code: string, nl: number): boolean {
  const lineStart = code.lastIndexOf('\n', nl - 1) + 1;
  const before = code.slice(lineStart, nl).replace(/\/\/.*$/, '');
  if (TRAILING_CONTINUATION.test(before)) return true;
  const nextEnd = code.indexOf('\n', nl + 1);
  const after = code.slice(nl + 1, nextEnd < 0 ? code.length : nextEnd);
  return LEADING_CONTINUATION.test(after);
}

/**
 * The end of a `function` declaration's braced body: the `}` matching the
 * first `{` after its parameter list, or the end of `code` when unbalanced.
 *
 * A `{` in TYPE position is not the body -- `function run(): { out: string } {`
 * opens an object type first. One preceded by `:`, `|`, `&`, `<` or `,` is
 * skipped past its matching `}`. Taking it for the body cut `run` off before it
 * named the target, and every test calling it read as never invoking anything.
 */
function functionBodyEnd(
  code: string,
  from: number,
  depth: Int32Array,
): number {
  let parens = 0;
  for (let k = from; k < code.length; k += 1) {
    const ch = code[k];
    if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === '{' && parens === 0) {
      const close = matchingBrace(code, k, depth);
      if (!/[:|&<,]\s*$/.test(code.slice(from, k))) return close;
      k = close - 1;
    }
  }
  return code.length;
}

/** One past the `}` matching the `{` at `open`, or the end of `code`. */
function matchingBrace(code: string, open: number, depth: Int32Array): number {
  const inner = (depth[open] ?? 0) + 1;
  for (let j = open + 1; j < code.length; j += 1) {
    if (code[j] === '}' && depth[j] === inner) return j + 1;
  }
  return code.length;
}

/** One same-file declaration: the names it binds and the text it owns. */
export interface LocalDecl {
  names: string[];
  body: string;
  /** Offset of `body` in the file, so the unblanked text can be read. */
  start: number;
}

export function localDecls(code: string, python: boolean): LocalDecl[] {
  const decls: LocalDecl[] = [];
  const re = python ? PY_LOCAL_DECL : JS_LOCAL_DECL;
  re.lastIndex = 0;
  const matches = [...code.matchAll(re)];
  const depth = python ? null : braceDepths(code);
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    const names = boundNames(m, python);
    if (names.length === 0) continue;
    const start = m.index! + m[0].length;
    const end = declEnd(code, matches, i, depth);
    decls.push({ names, body: code.slice(start, end), start });
  }
  if (!python) decls.push(...destructuredAssignDecls(code));
  return decls;
}

/** `({ a, b } = rhs)` bindings, each owning only its RHS. */
function destructuredAssignDecls(code: string): LocalDecl[] {
  const decls: LocalDecl[] = [];
  JS_DESTRUCTURED_ASSIGN.lastIndex = 0;
  for (const m of code.matchAll(JS_DESTRUCTURED_ASSIGN)) {
    const names = (m[1] ?? '')
      .split(',')
      .map((raw) => raw.split(':').pop()!.trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    // The RHS alone is the body here: unlike a declaration, an assignment
    // does not own the text that follows it.
    // The RHS is the last thing before the closing `)`.
    const body = m[2] ?? '';
    const start = m.index! + m[0].length - 1 - body.length;
    if (names.length > 0) decls.push({ names, body, start });
  }
  return decls;
}
