/**
 * canary-cassandra -- vacuous-test detection (#612).
 *
 * A vacuous test PASSES WITHOUT PROVING ANYTHING. It has assertions, it goes
 * green, and it goes green identically against the bug it was written to catch,
 * so every gate this repo owns reads it as healthy. Three shipped examples are
 * recorded in #486 and all three cleared coverage, `review-test`, and CI:
 *
 * - an assertion whose expectation could not have been false (`toBe(true)`),
 * - a test whose target was never actually invoked, and
 * - a test whose only assertion was an ABSENCE, which the buggy code satisfied
 *   by crashing before it could do anything.
 *
 * This module is one implementation, consumed by both the `canary vacuity-check`
 * CLI and the promotion gate (`promotion-verdict.ts`, #477). It is deliberately
 * NOT a self-contained `.mjs` skill: #605's accepted risk was that
 * `static_linter` and `quality_scorer` already overlap and a third
 * half-enforcer would be the real defect. `agents/skills/claude-code/
 * canary-cassandra/SKILL.md` drives this CLI rather than carrying a second copy
 * of the detection.
 *
 * ## The fidelity ladder, and why VAC-002 needs one
 *
 * A test's "declared target" is declared nowhere. Inferring it from imports is
 * exactly the heuristic tier STRATEGY.md distrusts, and the issue predicts the
 * failure precisely: a correct integration test gets flagged when the call sits
 * several frames deeper. So:
 *
 * - `annotated` -- the author wrote `@covers <symbol>`. The rule checks THAT
 *   symbol and says so.
 * - `import-inferred` -- no annotation, so the target set is the symbols
 *   imported from relative paths. For VAC-002 a same-file helper whose own body
 *   names one counts as invoking it, exactly one level deep; a longer chain, or
 *   a helper whose body cannot be read, abstains and is counted (#1170).
 *   VAC-003/VAC-005 still close over local declarations to a fixpoint.
 * - neither -- the target cannot be resolved. That is "cannot verify", which is
 *   a finding about the SCAN, so it lands in `skipped` with its reason.
 *
 * The inference reads four binding forms, because #705 measured what happens
 * when it reads one: 65 of 99 findings on canary's own tree were the namespace
 * import, the dynamic import, and the subprocess launch -- tests invoking
 * exactly what they claimed, through a construct the target set could not see.
 * The issue rules out every quiet answer (a threshold, a mute, a widened blanket
 * skip) on the grounds that a suppressed inference and a passing check must not
 * look alike, so the fix is to WIDEN WHAT THE INFERENCE CAN SEE and leave the
 * rule's authority untouched.
 *
 * A skip is PER RULE, not per test: `VAC-001` needs no target and always runs,
 * so a test whose target is unresolvable is still genuinely `checked` and stays
 * in the denominator. Saying otherwise would understate what was verified. What
 * must not happen is a reader mistaking that for a full pass, which is why
 * `promotion-verdict.ts` puts the skip count in its remedy rather than letting
 * `promote` read as unqualified.
 *
 * ## The denominator
 *
 * `scanVacuity` returns a {@link GateResult}, so a file it could not read
 * reports `checked: 0` and `gateOutcome` structurally refuses to print a pass.
 * A vacuity detector that could itself go quiet and look clean would be the
 * joke telling itself.
 */

import { readFileSync } from 'node:fs';

import {
  declaresDriverFixture,
  divertE2EInferred,
  importsBrowserDriver,
} from './e2e-context.js';
import type { GateResult, SkipEntry } from './gate-result.js';
import {
  ASSERT_JS,
  ASSERT_PY,
  enumerateTests,
  frameworkForPath,
  type TestBlock,
} from './static-linter.js';
import { blankStringContent } from './string-literals.js';

/** How the target under test was resolved. Mirrors the guardian's ladder. */
export type VacuityFidelity = 'annotated' | 'import-inferred';

export interface VacuityFinding {
  file: string;
  line: number;
  rule: 'VAC-001' | 'VAC-002' | 'VAC-003' | 'VAC-005';
  severity: 'critical' | 'warning';
  /** The test this is about, so a report can group by test rather than line. */
  test: string;
  message: string;
  suggestion: string;
  /** Only set on VAC-002, the one rule whose confidence varies. */
  fidelity?: VacuityFidelity;
}

/**
 * `@covers <symbol>` -- the explicit rung of the ladder.
 *
 * Global, because {@link annotationFor} needs the LAST match in its window, not
 * the first: `exec` returns the match nearest the start, which is the FARTHEST
 * annotation above the declaration.
 */
const COVERS_PRAGMA = /@covers\s+([A-Za-z_$][\w$]*)/g;

/**
 * An import whose specifier is relative: the local code a test can target.
 *
 * The namespace form (`import * as ns from './x.js'`) needs its own alternative
 * rather than falling out of `(\w+)`: `*` is not a word character, so a file
 * written entirely in namespace imports resolved to an EMPTY target set and
 * every test in it drew a `VAC-002` (#705). On canary's own `agents/skills/test`
 * tree that single omission was the largest share of the 65 findings the issue
 * counted -- `import * as diffscan from '../.../diffscan.mjs'` is the house
 * style there, and `diffscan.findDeletions(...)` is unmistakably an invocation
 * of the target.
 */
const JS_RELATIVE_IMPORT =
  /import\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\}|(\w+))[^'"]*from\s*['"](\.[^'"]*)['"]/g;
const JS_RELATIVE_REQUIRE =
  /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"](\.[^'"]*)['"]/g;
/**
 * `const x = await import('./y.js')` / `const { a } = await import('./y.js')`.
 *
 * A dynamic import leaves no static import statement, so a suite that loads its
 * subject this way -- to control module state per test, or to import a module
 * only after an env var is set -- resolved to no target at all (#705).
 */
const JS_DYNAMIC_IMPORT =
  /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*(?:await\s+)?import\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
/** A bare `await import('./y.js')` -- no binding, so it names no symbol. */
const JS_BARE_DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*['"]\.[^'"]*['"]\s*\)/;

/**
 * A string literal naming a first-party script -- something a subprocess can be
 * pointed at and that lives in this repo.
 *
 * The discriminator is deliberately the EXTENSION, not the path shape: it is
 * what separates `spawnSync(cli, ...)` where `cli` is
 * `path.join(SCRIPTS, 'cli.mjs')` from `spawnSync('git', args)`. A bare command
 * name is not a repo path and must not make a test look covered.
 */
const SCRIPT_PATH_LITERAL =
  /['"`][^'"`\n]*[\w$)/.-]\.(?:mjs|cjs|jsx?|tsx?|py|sh)['"`]/;

/**
 * A declaration binding one name to an expression -- the statement-bounded form
 * used to spot a handle on a first-party script.
 */
const JS_SIMPLE_DECL = /(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/g;

/** The child-process launchers whose first argument is an executable target. */
const SUBPROCESS_LAUNCH =
  /(?<![\w$.])(?:execFileSync|execSync|spawnSync|execFile|spawn|fork)\s*\(/;
/**
 * Python has no `.`-prefix requirement for a first-party import, so `from x
 * import y` counts. `import os` and the stdlib are excluded by name below --
 * a heuristic, but the alternative is treating every pytest file as
 * unresolvable.
 */
const PY_FROM_IMPORT =
  /^[ \t]*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm;
const PY_STDLIB = new Set([
  'os',
  'sys',
  'json',
  're',
  'time',
  'math',
  'pathlib',
  'typing',
  'datetime',
  'unittest',
  'pytest',
  'collections',
  'subprocess',
  'tempfile',
  'itertools',
  'functools',
  'socket',
  'uuid',
  'random',
]);

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
 */
const JS_LOCAL_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(?:\{([^}]*)\}|\[([^\]]*)\]|(\w+))(?:\s*:(?:[^=;\n]|=>)+?)?\s*=(?![=>]))/g;
const PY_LOCAL_DECL = /(?:^|\n)\s*def\s+(\w+)\s*\(/g;

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
 * Assertions whose expectation is an ABSENCE. A test built only from these
 * passes identically when the code under test never ran at all -- the
 * `canary-katana` case from #486, where a bare tmpdir exited before the write
 * and `expect(existsSync(...)).toBe(false)` was free.
 */
const ABSENCE_ASSERTION =
  /\.toBe\s*\(\s*(?:false|null|undefined)\s*\)|\.toBeNull\s*\(|\.toBeUndefined\s*\(|\.toBeFalsy\s*\(|\.toHaveLength\s*\(\s*0\s*\)|\.toEqual\s*\(\s*(?:\[\s*\]|\{\s*\})\s*\)|\.not\s*\.\s*to\w+/;
const PY_ABSENCE_ASSERTION =
  /\bassert\s+not\b|\bis\s+None\b|==\s*(?:False|None)\b|==\s*(?:\[\s*\]|\{\s*\})|\bassert\s+len\s*\([^)]*\)\s*==\s*0\b/;

/**
 * Any assertion at all -- imported from the linter rather than restated.
 *
 * A local `/\bexpect\s*\(|\bassert\s*[.(]/` was NOT the linter's vocabulary, and
 * the comment claiming it was is how the gap survived: `ASSERT_JS` also knows
 * `should`-style, `.should`, the `toThrow` family, and the
 * `expectX()`/`assertX()` helper convention that the linter's own notes say
 * accounted for 9 of 16 residual findings here. For a suite written in any of
 * those styles the assertion list came out EMPTY, VAC-003's `length > 0` guard
 * short-circuited, and the rule reported nothing while nothing said it could not
 * look -- the silent zero this module exists to prevent, one layer inside it.
 */
const JS_ASSERTION = ASSERT_JS;
const PY_ASSERTION = new RegExp(`${ASSERT_PY.source}|\\bself\\.assert\\w+`);

function mk(
  file: string,
  line: number,
  rule: VacuityFinding['rule'],
  severity: VacuityFinding['severity'],
  test: string,
  message: string,
  suggestion: string,
  fidelity?: VacuityFidelity,
): VacuityFinding {
  const f: VacuityFinding = {
    file,
    line,
    rule,
    severity,
    test,
    message,
    suggestion,
  };
  if (fidelity) f.fidelity = fidelity;
  return f;
}

function lineOf(code: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) {
    if (code[i] === '\n') n += 1;
  }
  return n;
}

/**
 * The identifiers a comma-separated import clause binds.
 *
 * `{ save as store }` binds `store`; `{ save }` binds `save`. Anything that is
 * not a bare identifier after that (`type Kit`, a stray comment) is dropped --
 * the filter is also what guarantees no name reaching {@link mentionsAny} can
 * carry regex metacharacters.
 */
function clauseNames(list: string | undefined): string[] {
  // Parentheses and newlines stripped first, so the multi-line
  // `from m import (\n  a,\n  b,\n)` form yields names rather than `(a` -- which
  // the identifier filter below silently dropped, taking the whole file's target
  // set with it.
  return (list ?? '')
    .replace(/[()\n]/g, ' ')
    .split(',')
    .map(
      (raw) =>
        raw
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? '',
    )
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** Python first-party imports: `from x import y`, minus the stdlib by name. */
function pythonImportedTargets(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(PY_FROM_IMPORT)) {
    const root = m[1]!.split('.')[0]!;
    if (PY_STDLIB.has(root)) continue;
    for (const n of clauseNames(m[2])) names.add(n);
  }
  return names;
}

/**
 * One binding form: which capture holds the `{...}` clause, and which the single
 * name (default import, namespace alias, or `const x = ...`).
 */
const JS_BINDING_FORMS: {
  re: RegExp;
  clause: number;
  singles: number[];
}[] = [
  { re: JS_RELATIVE_IMPORT, clause: 2, singles: [1, 3] },
  { re: JS_RELATIVE_REQUIRE, clause: 1, singles: [2] },
  { re: JS_DYNAMIC_IMPORT, clause: 1, singles: [2] },
];

/** JS/TS first-party imports: any `import`/`require` with a relative specifier. */
function jsImportedTargets(code: string): Set<string> {
  const names = new Set<string>();
  for (const { re, clause, singles } of JS_BINDING_FORMS) {
    // Reset explicitly: these are module-level `/g` patterns, so a leftover
    // `lastIndex` from an earlier file would silently skip the head of this one.
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      for (const n of clauseNames(m[clause])) names.add(n);
      for (const g of singles) if (m[g]) names.add(m[g]!);
    }
  }
  for (const n of subprocessScriptHandles(code)) names.add(n);
  return names;
}

/**
 * Names bound to a first-party SCRIPT PATH -- the target of a subprocess test.
 *
 * `agents/skills/test` drives most skill CLIs the way a user does, by spawning
 * them: `const cli = path.join(SCRIPTS, 'cli.mjs'); spawnSync(cli, ['--help'])`.
 * No symbol crosses that boundary, so import-inferred fidelity saw a test that
 * referenced none of its file's imports and reported `VAC-002` on a test that is
 * in fact exercising exactly what it claims (#705).
 *
 * The handle -- `cli` -- is the symbol that stands in for the target, so binding
 * it is what lets the existing machinery work unchanged, `closeOverLocals`
 * included. A launch site must be present in the file: a path literal on its own
 * is data (a fixture, an expected value), not an invocation.
 */
function subprocessScriptHandles(code: string): Set<string> {
  const names = new Set<string>();
  if (!SUBPROCESS_LAUNCH.test(code)) return names;
  JS_SIMPLE_DECL.lastIndex = 0;
  for (const m of code.matchAll(JS_SIMPLE_DECL)) {
    if (SCRIPT_PATH_LITERAL.test(m[2] ?? '')) names.add(m[1]!);
  }
  return names;
}

/**
 * Does this test body itself reach first-party code the target set cannot name?
 *
 * Two shapes, both of which leave no identifier to match: a subprocess launched
 * at a script path written inline (`spawnSync(path.join(D, 'cli.mjs'), ...)`),
 * and a bare `await import('./x.js')` whose result is never bound. Read from the
 * ORIGINAL source rather than the blanked copy, because the evidence in both
 * cases IS the string literal.
 *
 * `SUBPROCESS_LAUNCH` and `SCRIPT_PATH_LITERAL` are required together: a test
 * that spawns `git` and separately mentions a `.py` fixture path is not covered
 * by either half alone.
 */
function reachesOutOfBandTarget(rawBody: string): boolean {
  if (SUBPROCESS_LAUNCH.test(rawBody) && SCRIPT_PATH_LITERAL.test(rawBody))
    return true;
  return JS_BARE_DYNAMIC_IMPORT.test(rawBody);
}

/** Names imported from first-party (relative) modules. */
function importedTargets(code: string, python: boolean): Set<string> {
  return python ? pythonImportedTargets(code) : jsImportedTargets(code);
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

/**
 * Grow `targets` with local declarations that themselves reach a target, to a
 * fixpoint.
 *
 * This is the concession the issue asked for. Without it, a test that goes
 * through a helper defined in the same file -- `roundTrip()` calling
 * `load(save(v))` -- reads as never touching its target, and the rule
 * confidently reports a correct test as vacuous. One hop covers the common
 * case; the fixpoint covers a chain of them.
 *
 * VAC-003/VAC-005 read this closure. VAC-002 does not: since #1170 it credits
 * one helper level only and treats the rest of the chain as an abstention (see
 * `helperVerdict`).
 */
function closeOverLocals(
  decls: LocalDecl[],
  targets: Set<string>,
): Set<string> {
  const reaching = new Set(targets);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of decls) {
      if (d.names.every((n) => reaching.has(n))) continue;
      if (!mentionsAny(d.body, reaching)) continue;
      for (const n of d.names) reaching.add(n);
      grew = true;
    }
  }
  return reaching;
}

/** Local names whose OWN body names a direct target: one level, no further. */
function oneLevelHelpers(decls: LocalDecl[], direct: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const d of decls) {
    if (!mentionsAny(d.body, direct)) continue;
    for (const n of d.names) if (!direct.has(n)) names.add(n);
  }
  return names;
}

/**
 * `let parse;` / `let parse: Parser;` -- a module-scope name with no
 * initializer, typically assigned later in a hook by a plain assignment no
 * declaration pattern bounds. Its body cannot be resolved, so a test that calls
 * it abstains (#1170) rather than being judged on a helper nobody read.
 */
const JS_UNINITIALIZED_DECL =
  /(?:^|\n)\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*(?::(?:[^=;\n]|=>)+)?;/g;

function unresolvedNames(code: string, decls: LocalDecl[]): Set<string> {
  const resolved = new Set(decls.flatMap((d) => d.names));
  const names = new Set<string>();
  JS_UNINITIALIZED_DECL.lastIndex = 0;
  for (const m of code.matchAll(JS_UNINITIALIZED_DECL)) {
    if (!resolved.has(m[1]!)) names.add(m[1]!);
  }
  return names;
}

/** One same-file declaration: the names it binds and the text it owns. */
interface LocalDecl {
  names: string[];
  body: string;
}

function localDecls(code: string, python: boolean): LocalDecl[] {
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
    decls.push({ names, body: code.slice(start, end) });
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
    if (names.length > 0) decls.push({ names, body: m[2] ?? '' });
  }
  return decls;
}

/** One body line: blanked `text`, the same offsets unblanked as `raw`. */
interface BodyLine {
  text: string;
  raw: string;
  line: number;
}

/**
 * Body lines of a test, paired with their 1-based line numbers.
 *
 * Blanking is offset-preserving, so the raw slice splits into lines of exactly
 * the same lengths -- `raw` is what VAC-001 compares (#1171).
 */
function bodyLines(code: string, source: string, block: TestBlock): BodyLine[] {
  const first = lineOf(code, block.bodyStart);
  const raw = source
    .slice(block.bodyStart, block.bodyStart + block.body.length)
    .split('\n');
  return block.body
    .split('\n')
    .map((text, i) => ({ text, raw: raw[i] ?? text, line: first + i }));
}

function isComment(line: string): boolean {
  const s = line.trim();
  return s.startsWith('#') || s.startsWith('//') || s.startsWith('*');
}

/** The text inside a balanced `expect(...)`, or null. */
/**
 * The index of the `)` balancing the `(` at `open`, or -1.
 *
 * Shared so that BOTH sides of a comparison are extracted by the same strategy.
 * They were not: the expected side used a paren-excluding character class, so
 * `expect(res.status()).toBe(res.status())` -- textually self-comparing and
 * incapable of failing -- was passed over while `expect(code).toBe(code)` was
 * flagged (#1076). The call form is the common shape in API and integration
 * suites, so the rule was weakest exactly where it mattered most.
 */
function closingParen(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function expectArgument(line: string): string | null {
  const open = line.indexOf('expect(');
  if (open < 0) return null;
  const close = closingParen(line, open + 'expect'.length);
  return close < 0 ? null : line.slice(open + 'expect('.length, close);
}

/**
 * The matcher following `expect(...)`: its argument, and whether it is negated.
 *
 * The negation is returned rather than swallowed. `expect(v).not.toBe(v)` has
 * identical texts on both sides, so a comparison that ignored `.not` reported it
 * as `VAC-001` -- "no implementation can fail it" -- about an assertion that can
 * only ever FAIL. Inverting the rule's own claim is worse than missing the case,
 * and it was a `critical` finding that BLOCKS promotion. `pyTautology` already
 * guarded the analogous `assert False`; the JS path had no equivalent.
 *
 * The search starts AFTER the balanced close of `expect(...)`, so a call inside
 * the actual side (`expect(x.toString()).toBe(y)`) cannot be mistaken for the
 * matcher now that the argument is no longer restricted to paren-free text.
 */
function matcherOf(
  line: string,
): { argument: string; start: number; negated: boolean } | null {
  const expectOpen = line.indexOf('expect(');
  let after = 0;
  if (expectOpen >= 0) {
    const expectClose = closingParen(line, expectOpen + 'expect'.length);
    if (expectClose < 0) return null;
    after = expectClose + 1;
  }
  const m = /\.\s*(not\s*\.\s*)?to\w+\s*\(/.exec(line.slice(after));
  if (!m) return null;
  const open = after + m.index + m[0].length - 1;
  const close = closingParen(line, open);
  if (close < 0) return null;
  return {
    argument: line.slice(open + 1, close),
    start: open + 1,
    negated: m[1] !== undefined,
  };
}

function normalize(expr: string): string {
  return expr.replace(/\s+/g, '');
}

/**
 * `expr` with whitespace removed everywhere EXCEPT inside string literals.
 *
 * VAC-001's comparison key (#1171). The sides used to be compared on the
 * BLANKED line, where every string's content is spaces, and `normalize` then
 * deleted those spaces too -- so `score(9, 0, "severe")` and
 * `score(9, 0, "unknown")` both became `score(9,0,"")` and a comparison of two
 * different calls was reported as a `critical` self-comparison. Reading the raw
 * text keeps the arguments; keeping whitespace inside quotes keeps `'a b'` and
 * `'ab'` apart.
 */
function normalizeExpression(expr: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i]!;
    if (quote !== null) {
      out += c;
      if (c === '\\' && i + 1 < expr.length) out += expr[(i += 1)]!;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

/** Same-length spans of the raw line, compared as full call expressions. */
function sameExpression(
  raw: string,
  a: [number, number],
  e: [number, number],
): boolean {
  const left = normalizeExpression(raw.slice(...a));
  const right = normalizeExpression(raw.slice(...e));
  return left !== '' && left === right;
}

/**
 * VAC-001 for one JS/TS line.
 *
 * Structure is read from `line` (blanked, so a `)` inside a string cannot
 * unbalance the extraction) and the two sides are then compared on `raw`, the
 * same offsets in the unblanked source, so string arguments count (#1171).
 */
function jsTautology(line: string, raw: string): boolean {
  const actual = expectArgument(line);
  const matcher = matcherOf(line);
  if (actual === null || matcher === null || matcher.negated) return false;
  if (normalize(actual) === '' || normalize(matcher.argument) === '')
    return false;
  const aStart = line.indexOf('expect(') + 'expect('.length;
  return sameExpression(
    raw,
    [aStart, aStart + actual.length],
    [matcher.start, matcher.start + matcher.argument.length],
  );
}

/** VAC-001 for one pytest line; `raw` is the unblanked line (#1171). */
function pyTautology(line: string, raw: string): boolean {
  const t = line.trim();
  // `assert False` is a deliberate unreachable marker -- it can only ever fail,
  // so it is the opposite of vacuous and must never be flagged.
  if (/^assert\s+True\s*(?:,|$)/.test(t)) return true;
  // Same reason `.not` is excluded above: `assert x != x` can only ever fail.
  const cmp = /^assert\s+(.+?)\s*==\s*(.+?)\s*(?:,|$)/d.exec(t);
  if (!cmp?.indices) return false;
  const lead = line.length - line.trimStart().length;
  const shift = ([s, e]: [number, number]): [number, number] => [
    s + lead,
    e + lead,
  ];
  return sameExpression(raw, shift(cmp.indices[1]!), shift(cmp.indices[2]!));
}

function scanBlock(
  ctx: ScanContext,
  block: TestBlock,
  annotated: string | null,
  skipped: SkipEntry[],
  outOfBand: boolean,
): VacuityFinding[] {
  const { code, source, path: file, python, inference } = ctx;
  const lines = bodyLines(code, source, block).filter(
    (l) => !isComment(l.text),
  );
  const reaching = inference?.reaching ?? null;
  const targets = annotated !== null ? new Set([annotated]) : reaching;
  const invoked =
    annotated === null && !outOfBand
      ? helperVerdict(block.body, inference)
      : 'invoked';
  if (invoked === 'deeper' || invoked === 'unresolved') {
    // Abstain, counted: the helper chain is too deep or too opaque to judge,
    // and #1170's contract is that such a test is neither passed in silence
    // nor accused. `helperAbstained` on the result is this list's length.
    ctx.helperAbstentions.push({
      name: skipLabel('VAC-002', file, block),
      reason: HELPER_ABSTAIN_REASON[invoked],
    });
  }
  return [
    ...tautologies(lines, block, file, python),
    ...targetNeverInvoked(block, lines, file, invoked, annotated),
    ...absenceOnly(lines, block, file, python, targets, skipped),
    ...presenceOnBystander(lines, block, file, python, targets),
  ];
}

/** How a test reaches its import-inferred target, if it does (#1170). */
type HelperVerdict = 'invoked' | 'deeper' | 'unresolved' | 'never';

const HELPER_ABSTAIN_REASON = {
  deeper:
    'target reached only through more than one level of same-file helpers, so VAC-002 abstains rather than guess',
  unresolved:
    'test calls a same-file helper whose body could not be resolved, so VAC-002 abstains rather than guess',
} as const;

/**
 * The approved contract for #1170, in order:
 *
 * 1. the body names an imported target -- invoked;
 * 2. it names a same-file helper whose OWN body names one -- invoked, exactly
 *    one level deep;
 * 3. it names a helper that reaches only through further helpers -- `deeper`;
 * 4. it CALLS a same-file name whose body could not be read -- `unresolved`;
 * 5. otherwise `never`, which is the real VAC-002 and still reported.
 *
 * 3 and 4 abstain rather than pass: the fixpoint closure used to answer them
 * silently, and a helper chain the scanner cannot see the end of is not proof
 * the target ran.
 */
function helperVerdict(
  body: string,
  inference: TargetInference | null,
): HelperVerdict {
  if (inference === null) return 'invoked';
  if (mentionsAny(body, inference.direct)) return 'invoked';
  if (mentionsAny(body, inference.oneLevel)) return 'invoked';
  if (mentionsAny(body, inference.reaching)) return 'deeper';
  const calls = [...inference.unresolved].some((n) =>
    new RegExp(`${identifierPattern(n).source}\\s*\\(`).test(body),
  );
  return calls ? 'unresolved' : 'never';
}

/**
 * A pattern matching `name` as a whole identifier.
 *
 * NOT `\b${name}\b`, which is wrong for the `$` that JS identifiers allow and
 * `\w` does not. `\b` sits between a `\w` and a non-`\w`, so `\b$fetch\b` can
 * only match after a word character -- a `$`-prefixed import never matched at
 * all, and `\bfoo$bar\b` can never match. That silently shrank the target set,
 * producing a `VAC-002` false positive on a test invoking its target on the only
 * line it had. Lookarounds over `[\w$]` give the boundary JS actually has.
 *
 * `name` is escaped as well: every call site filters to `[A-Za-z_$][\w$]*`
 * today, so nothing can currently smuggle a metacharacter through, but the
 * escape means a widened filter cannot turn into a silent semantic change.
 */
function identifierPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
}

/** Does `text` name any symbol in `targets`? */
function mentionsAny(text: string, targets: Set<string> | null): boolean {
  return (
    targets !== null &&
    [...targets].some((t) => identifierPattern(t).test(text))
  );
}

/**
 * VAC-001 -- deterministic, hence `critical`: an expectation identical to the
 * value it checks cannot fail for any implementation.
 */
function tautologies(
  lines: BodyLine[],
  block: TestBlock,
  file: string,
  python: boolean,
): VacuityFinding[] {
  return lines
    .filter((l) =>
      python ? pyTautology(l.text, l.raw) : jsTautology(l.text, l.raw),
    )
    .map((l) =>
      mk(
        file,
        l.line,
        'VAC-001',
        'critical',
        block.name,
        'Assertion compares a value with itself; no implementation can fail it.',
        'Assert the value the code under test should have produced, not the input.',
      ),
    );
}

/**
 * VAC-002 -- the target is never referenced anywhere in the body.
 *
 * An annotated target must be referenced by CODE (`lines` is comment-free). A
 * JS body runs to the next declaration, so it carries the NEXT test's
 * `// @covers` comment; read as a reference, the same annotation repeated above
 * consecutive tests cleared every one of them but the last (#1232).
 */
function targetNeverInvoked(
  block: TestBlock,
  lines: BodyLine[],
  file: string,
  invoked: HelperVerdict,
  annotated: string | null,
): VacuityFinding[] {
  if (annotated !== null) {
    const code = lines.map((l) => l.text).join('\n');
    if (mentionsAny(code, new Set([annotated]))) return [];
    return [
      mk(
        file,
        block.line,
        'VAC-002',
        'warning',
        block.name,
        `Declared target \`${annotated}\` is never referenced in this test.`,
        'Invoke the target, or correct the @covers annotation to name what the test actually exercises.',
        'annotated',
      ),
    ];
  }
  // `invoked` already folds in the out-of-band shapes (#705), an unresolvable
  // target set (skipped elsewhere), and the helper abstentions (#1170).
  if (invoked !== 'never') return [];
  return [
    mk(
      file,
      block.line,
      'VAC-002',
      'warning',
      block.name,
      'This test references none of the symbols the file imports from first-party modules.',
      'If the target is reached indirectly, add `// @covers <symbol>` so the check verifies the real target instead of inferring one.',
      'import-inferred',
    ),
  ];
}

/**
 * VAC-003 -- every assertion is an absence, AND none of them observes the
 * target.
 *
 * That second clause is not a refinement, it is the rule. The first cut omitted
 * it and reported 254 findings across canary's 2154 tests, nearly all of the
 * form `expect(isCI()).toBe(false)` -- a perfectly good negative test, because
 * the assertion invokes the target, so the target provably ran and the `false`
 * is load-bearing. The #486 katana defect is the other shape:
 * `expect(existsSync(ledger)).toBe(false)` after a bare call, where the absence
 * is observed on a BYSTANDER and the buggy code satisfied it by exiting before
 * the write. Reported at the first absence assertion, the line an author adds a
 * precondition next to.
 */
/**
 * A test title safe to put in a skip label: its first line, capped at 80.
 *
 * The title parser can mis-read a declaration and hand back the source after
 * it (#860 -- whole `describe` bodies reached the summary line). Bounding the
 * label here means a parser slip degrades to a truncated name, never a flood.
 */
export function boundedTitle(name: string): string {
  const first = name.split('\n', 1)[0]!.trim();
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function skipLabel(rules: string, file: string, block: TestBlock): string {
  return `${file}:${block.line} ${rules} (${boundedTitle(block.name)})`;
}

function absenceOnly(
  lines: { text: string; line: number }[],
  block: TestBlock,
  file: string,
  python: boolean,
  targets: Set<string> | null,
  skipped: SkipEntry[],
): VacuityFinding[] {
  if (targets === null) return [];
  const anyAssertion = python ? PY_ASSERTION : JS_ASSERTION;
  const absence = python ? PY_ABSENCE_ASSERTION : ABSENCE_ASSERTION;
  const assertions = lines.filter((l) => anyAssertion.test(l.text));
  if (assertions.length === 0) {
    // Zero recognised assertions is unanswerable, not clean: either the test
    // asserts nothing (which is `LINT-006`'s finding, not this rule's) or its
    // assertion style is one the vocabulary does not know. Both are "cannot
    // verify", so both are recorded rather than passed over in silence.
    skipped.push({
      name: skipLabel('VAC-003', file, block),
      reason:
        'no recognised assertion, so absence-only could not be judged -- the test may assert nothing (LINT-006) or use an unrecognised assertion style',
    });
    return [];
  }
  if (!assertions.every((l) => absence.test(l.text))) return [];
  if (assertions.some((l) => mentionsAny(l.text, targets))) return [];
  return [
    mk(
      file,
      assertions[0]!.line,
      'VAC-003',
      'warning',
      block.name,
      'Every assertion in this test asserts an absence, and none of them observes the target.',
      'Add one assertion proving the operation actually ran (exit code, returned value, a positive existence) -- otherwise the test passes identically when the code crashed before doing anything.',
    ),
  ];
}

/**
 * Presence matchers that a value the test built for itself satisfies before the
 * target ever runs. The negated-null forms belong here too, but on their own they
 * also match `ABSENCE_ASSERTION` (via `.not.to*`), so an all-negated test stays
 * VAC-003's -- see {@link presenceOnBystander}.
 */
const TRIVIAL_PRESENCE_JS =
  /\.toBeDefined\s*\(\s*\)|\.toBeTruthy\s*\(\s*\)|\.not\s*\.\s*(?:toBeNull|toBeUndefined|toBeFalsy)\s*\(\s*\)/;
const TRIVIAL_PRESENCE_PY =
  /^assert\s+([A-Za-z_][\w.]*?)(?:\s+is\s+not\s+None)?\s*(?:,|$)/;
const SUBJECT_ROOT = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * An assertion line that proves only an absence or a trivial presence.
 *
 * Exported for the test inventory's depth tier (#957), so "weak" means the same
 * thing there as it does to VAC-003 and the bystander rule.
 */
export function isWeakAssertion(line: string, python: boolean): boolean {
  const t = line.trim();
  if (python)
    return PY_ABSENCE_ASSERTION.test(t) || TRIVIAL_PRESENCE_PY.test(t);
  return ABSENCE_ASSERTION.test(t) || TRIVIAL_PRESENCE_JS.test(t);
}

/** Any recognised assertion, in the vocabulary the linter uses. */
export function isAssertion(line: string, python: boolean): boolean {
  return (python ? PY_ASSERTION : JS_ASSERTION).test(line);
}

/** True for a Python module root the target inference treats as stdlib. */
export function isPythonStdlibModule(moduleRoot: string): boolean {
  return PY_STDLIB.has(moduleRoot);
}

function subjectRoot(expr: string | null | undefined): string | null {
  return expr ? (SUBJECT_ROOT.exec(normalize(expr))?.[1] ?? null) : null;
}

/** The root identifier a trivial presence assertion observes, or null. */
function presenceSubject(text: string, python: boolean): string | null {
  const t = text.trim();
  if (python) return subjectRoot(TRIVIAL_PRESENCE_PY.exec(t)?.[1]);
  return TRIVIAL_PRESENCE_JS.test(t) ? subjectRoot(expectArgument(t)) : null;
}

/**
 * Every binding of a name inside the body: `const x = rhs` / `x = rhs` (JS) or
 * `x = rhs` (pytest), with the RHS bounded to its own line.
 *
 * Deliberately NOT `closeOverLocals`: that bounds a declaration at its next
 * sibling, so a `const subs = [...]` inside a test absorbs the rest of the test
 * -- including the target call -- and `subs` reads as reaching the target. That
 * is exactly the bystander this rule exists to see.
 */
function bodyBindings(
  lines: { text: string; line: number }[],
  python: boolean,
): { name: string; rhs: string; declared: boolean }[] {
  const re = python
    ? /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$/
    : /^\s*(const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*(.*)$/;
  const out: { name: string; rhs: string; declared: boolean }[] = [];
  for (const { text } of lines) {
    const m = re.exec(text);
    if (!m) continue;
    if (python) out.push({ name: m[1]!, rhs: m[2]!, declared: true });
    else out.push({ name: m[2]!, rhs: m[3]!, declared: m[1] !== undefined });
  }
  return out;
}

/** Is `rhs` a whole statement on its line? A dangling bracket means it is not. */
function balanced(rhs: string): boolean {
  let d = 0;
  for (const c of rhs) {
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
  }
  return d === 0;
}

/**
 * VAC-005 -- every assertion is a trivially true presence check, and its subject
 * is a BYSTANDER: a name the test itself bound, never from anything reaching the
 * target (#870). The mirror image of VAC-003:
 *
 * ```js
 * const subs = [{ id: 's1' }];
 * matchSubmissions([], subs);
 * expect(subs).toBeDefined();   // true before the call, true after it
 * ```
 *
 * The bystander clause is the rule, for the same reason VAC-003's is:
 * `const r = target(); expect(r).toBeDefined()` DOES observe the target, and a
 * throw from it would fail the test. Anything the rule cannot prove is a
 * bystander -- a name bound in a hook or at module scope, a multi-line RHS --
 * yields no finding, so the error direction is always a miss, never a false
 * accusation.
 */
function presenceOnBystander(
  lines: { text: string; line: number }[],
  block: TestBlock,
  file: string,
  python: boolean,
  targets: Set<string> | null,
): VacuityFinding[] {
  if (targets === null) return [];
  const anyAssertion = python ? PY_ASSERTION : JS_ASSERTION;
  const absence = python ? PY_ABSENCE_ASSERTION : ABSENCE_ASSERTION;
  const assertions = lines.filter((l) => anyAssertion.test(l.text));
  if (assertions.length === 0) return [];
  // All-absence (the negated-null forms included) is VAC-003's to report.
  if (assertions.every((l) => absence.test(l.text))) return [];
  const subjects = assertions.map((l) => presenceSubject(l.text, python));
  if (subjects.some((s) => s === null)) return [];

  const bindings = bodyBindings(lines, python);
  if (bindings.some((b) => !balanced(b.rhs))) return [];
  // The body's own names are removed first -- `closeOverLocals` over-attributes
  // them (see `bodyBindings`) -- then re-derived here from their real RHS, to a
  // fixpoint so `const r = save(); const s = r;` still reaches.
  const bound = new Set(bindings.map((b) => b.name));
  const reaching = new Set([...targets].filter((t) => !bound.has(t)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bindings) {
      if (reaching.has(b.name) || !mentionsAny(b.rhs, reaching)) continue;
      reaching.add(b.name);
      grew = true;
    }
  }
  const bystander = (name: string) =>
    !reaching.has(name) && bindings.some((b) => b.name === name && b.declared);
  if (!subjects.every((s) => bystander(s!))) return [];
  return [
    mk(
      file,
      assertions[0]!.line,
      'VAC-005',
      'warning',
      block.name,
      `Every assertion is a presence check on \`${subjects[0]}\`, a value the test built itself; it holds whether or not the target ran.`,
      'Assert on what the target returns or changes -- e.g. `expect(target(input)).toEqual(expected)` -- so the test fails when the target is wrong.',
    ),
  ];
}

/** A zero-denominator result that names why it could not measure. */
function unreadable(path: string, reason: string): GateResult<VacuityFinding> {
  return { checked: 0, findings: [], skipped: [{ name: path, reason }] };
}

/**
 * The file's text, or the reason it could not be read.
 *
 * An unreadable path is a zero, and it was the worst-shaped one: left to throw,
 * `readFileSync` escaped the command handler, so the CLI printed a raw ENOENT
 * stack and exited **0**. A gate that could not open its input and reported
 * success is precisely the false green this module exists to detect.
 *
 * Deliberately a discriminated result rather than `null` plus a module-level
 * `lastError`: a module-level mutable that a function writes to is the first
 * thing `canary-savant` flags, and it would be an odd thing to ship inside the
 * repo's own test-quality tooling.
 */
type ReadResult = { ok: true; source: string } | { ok: false; reason: string };

function readSource(path: string): ReadResult {
  try {
    return { ok: true, source: readFileSync(path, 'utf-8') };
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'unknown error';
    return { ok: false, reason: `could not be read (${code})` };
  }
}

/**
 * The target set for the `import-inferred` rung, or `null` when there is none.
 *
 * Imports are read from the ORIGINAL source, not the blanked copy: blanking
 * replaces literal CONTENT with spaces, so `from './store.js'` becomes
 * `from '           '` and the leading `.` that marks a first-party module is
 * gone -- which silently collapsed every JS/TS file to "target unresolvable".
 *
 * The cost is that an import written inside a fixture string is read as real.
 * That only ever ADDS names to the target set, which makes VAC-002 quieter,
 * never noisier -- the safe direction for a heuristic-tier rule.
 */
function resolveTargets(
  source: string,
  code: string,
  python: boolean,
): TargetInference | null {
  const direct = importedTargets(source, python);
  if (direct.size === 0) return null;
  const decls = localDecls(code, python);
  return {
    direct,
    reaching: closeOverLocals(decls, direct),
    oneLevel: oneLevelHelpers(decls, direct),
    unresolved: python ? new Set() : unresolvedNames(code, decls),
  };
}

/**
 * The `import-inferred` target, at the grains its two consumers need.
 *
 * VAC-003/VAC-005 ask "does this assertion observe anything reaching the
 * target" and keep the full fixpoint `reaching`. VAC-002 asks "did this test
 * invoke the target", and #1170 fixed its answer at ONE helper level, so it
 * reads `direct` and `oneLevel` and treats the rest of `reaching` -- and any
 * `unresolved` helper -- as an abstention.
 */
interface TargetInference {
  direct: Set<string>;
  reaching: Set<string>;
  oneLevel: Set<string>;
  unresolved: Set<string>;
}

/**
 * The `@covers` symbol declared above `block`, or `null`.
 *
 * The annotation is read from the run of comment lines ATTACHED to the
 * declaration -- the lines directly above it that are comments, blanks, or (in
 * Python) decorators -- plus the declaration line itself up to the name. The
 * run stops at the first line of code, which is how a previous test's
 * annotation is kept out: its declaration, or at least its closing line, sits
 * between the two.
 *
 * Three bugs lived in earlier versions:
 *
 * - A blind 400-character look-back reached over the PREVIOUS test and its
 *   annotation -- a FALSE BLOCK, since `annotated` is the one vacuity fidelity
 *   allowed to block a promotion.
 * - The fix for that floored the window at the end of the previous test's body.
 *   But a body runs to the NEXT declaration, so the comment above this test was
 *   inside the previous body and never read: every annotation after a file's
 *   first was dropped (#1232) -- a FALSE GREEN, because a wrong `@covers` went
 *   unchecked. Body boundaries are shared with LINT-006 and the test inventory,
 *   so the window changed rather than the boundary.
 * - `exec` returns the match nearest the START of the window, i.e. the FARTHEST
 *   annotation above the declaration. It takes the last, which is the nearest.
 *
 * A multi-line decorator (`@pytest.mark.parametrize(` over several lines) ends
 * the run early, so an annotation above one is not read: the test falls back to
 * import inference, which is the pre-annotation behaviour, not a false block.
 */
function annotationFor(
  code: string,
  block: TestBlock,
  python: boolean,
): string | null {
  const decl = python ? block.bodyStart : jsDeclarationStart(code, block);
  let from = code.lastIndexOf('\n', decl - 1) + 1;
  while (from > 0) {
    // Search a slice, not `lastIndexOf('\n', from - 2)`: at `from === 1` that
    // index is -1, which `lastIndexOf` clamps to 0 -- so a file opening with a
    // blank line found its own leading `\n`, `above` stayed 1, and the walk
    // never advanced (a hang on any file whose first line is empty).
    const above = code.slice(0, from - 1).lastIndexOf('\n') + 1;
    if (!attachesToDeclaration(code.slice(above, from - 1), python)) break;
    from = above;
  }
  const window = code.slice(from, block.bodyStart);
  const matches = [...window.matchAll(COVERS_PRAGMA)];
  return matches.at(-1)?.[1] ?? null;
}

/**
 * Offset of the `it`/`test` keyword opening a JS declaration, or of the body
 * start when it cannot be found. Python needs none of this: `def test_x(` is
 * matched on one line, so its body always starts on the declaration's line.
 *
 * A title wrapped onto its own line (`it(\n  'name',`) puts `bodyStart` a line
 * below the keyword, and the walk in {@link annotationFor} must begin at the
 * keyword's line or it stops at `it(` as code. The name holds no quote, so the
 * character before `bodyStart` is the closing quote and the previous one of the
 * same kind opens it; the search before that is bounded so a file of many
 * tests stays linear.
 */
function jsDeclarationStart(code: string, block: TestBlock): number {
  const quote = code[block.bodyStart - 1]!;
  if (quote !== "'" && quote !== '"') return block.bodyStart;
  const open = code.lastIndexOf(quote, block.bodyStart - 2);
  if (open < 0) return block.bodyStart;
  const from = Math.max(0, open - 80);
  const kw = code.slice(from, open).search(/\b(?:it|test)\s*\(\s*$/);
  return kw < 0 ? block.bodyStart : from + kw;
}

/** Can `line` sit between a test's annotation and its declaration? */
function attachesToDeclaration(line: string, python: boolean): boolean {
  const s = line.trim();
  if (s === '' || s.startsWith('/*') || isComment(s)) return true;
  return python && s.startsWith('@');
}

/**
 * Scan one test file for vacuous tests.
 *
 * `checked` counts the tests actually analysed. A file no ruleset can parse
 * yields `checked: 0` plus a skip entry, never an empty finding list that reads
 * as clean.
 */
export function scanVacuity(path: string): VacuityResult {
  const framework = frameworkForPath(path);
  if (framework === null) {
    return unreadable(
      path,
      'no ruleset parses this extension, so a clean result would be meaningless',
    );
  }
  const python = framework === 'pytest';
  const read = readSource(path);
  if (!read.ok) return unreadable(path, read.reason);
  const source = read.source;

  // Whole-source blanking, offset-preserving: a `expect(true).toBe(true)`
  // carried as fixture DATA is not a vacuous test, and a `it(...)` inside a
  // string must not be able to truncate a real test's body (#590).
  const code = blankStringContent(source, { python, path });
  const blocks = enumerateTests(code, source, python);
  const inference = resolveTargets(source, code, python);

  const skipped: SkipEntry[] = [];
  const ctx: ScanContext = {
    code,
    source,
    path,
    python,
    inference,
    driverImport: !python && importsBrowserDriver(source),
    sourceLines: source.split('\n'),
    helperAbstentions: [],
  };
  const findings = scanAllBlocks(ctx, blocks, skipped);
  skipped.push(...ctx.helperAbstentions);

  const result: VacuityResult = {
    checked: blocks.length,
    findings,
  };
  if (skipped.length > 0) result.skipped = skipped;
  if (ctx.helperAbstentions.length > 0)
    result.helperAbstained = ctx.helperAbstentions.length;
  return result;
}

/**
 * A vacuity scan: the shared gate result, plus the one count only this scanner
 * has.
 *
 * `helperAbstained` counts the tests whose VAC-002 verdict abstained because
 * the target sat more than one same-file helper deep, or behind a helper whose
 * body could not be resolved (#1170). Each one is ALSO a `skipped` entry, so
 * every surface that renders skips discloses it; the count exists so a report
 * can say how many without parsing reasons. Absent means zero.
 */
export interface VacuityResult extends GateResult<VacuityFinding> {
  helperAbstained?: number;
}

/** The invariants every block in one file shares. */
interface ScanContext {
  code: string;
  /**
   * The unblanked text. Blanking is offset-preserving, so a block's raw body is
   * the same slice -- needed by {@link reachesOutOfBandTarget}, whose evidence
   * is a string literal.
   */
  source: string;
  path: string;
  python: boolean;
  inference: TargetInference | null;
  /** VAC-002 helper abstentions, merged into `skipped` and counted (#1170). */
  helperAbstentions: SkipEntry[];
  /** The file imports a browser-driver package (#971). */
  driverImport: boolean;
  /** `source` by line, for reading a test's declaration signature. */
  sourceLines: string[];
}

/** Is `block` a browser-driver test -- by file import, or by fixture (#971)? */
function inE2EContext(ctx: ScanContext, block: TestBlock): boolean {
  if (ctx.driverImport) return true;
  return (
    !ctx.python && declaresDriverFixture(ctx.sourceLines[block.line - 1] ?? '')
  );
}

function scanAllBlocks(
  ctx: ScanContext,
  blocks: TestBlock[],
  skipped: SkipEntry[],
): VacuityFinding[] {
  const findings: VacuityFinding[] = [];
  for (const block of blocks) {
    const annotated = annotationFor(ctx.code, block, ctx.python);
    const outOfBand =
      !ctx.python &&
      annotated === null &&
      reachesOutOfBandTarget(
        ctx.source.slice(block.bodyStart, block.bodyStart + block.body.length),
      );
    if (annotated === null && ctx.inference === null) {
      // Both target-dependent rules go dark together, and both say so. VAC-003
      // asks "does any assertion observe the target", which is unanswerable
      // without a target -- so it abstains rather than falling back to the
      // 254-false-positive version of itself.
      //
      // An out-of-band reach answers VAC-002 (the test DOES invoke first-party
      // code) but not VAC-003, which needs a SYMBOL to ask "did an assertion
      // observe it". So the skip narrows rather than disappearing: reporting
      // both as dark would overstate the gap, dropping it entirely would hide a
      // real one, and #705 is explicit that a suppressed inference and a passing
      // check must not look alike.
      skipped.push({
        name: skipLabel(
          outOfBand ? 'VAC-003' : 'VAC-002/VAC-003',
          ctx.path,
          block,
        ),
        reason: outOfBand
          ? 'target reached out of band (subprocess or bare dynamic import), so VAC-002 is answered but no symbol exists for absence-only to observe'
          : 'target unresolvable: no @covers annotation and no first-party relative import to infer from',
      });
    }
    const blockFindings = scanBlock(ctx, block, annotated, skipped, outOfBand);
    findings.push(
      ...divertE2EInferred(
        blockFindings,
        inE2EContext(ctx, block),
        skipLabel('VAC-002', ctx.path, block),
        skipped,
      ),
    );
  }
  return findings;
}
