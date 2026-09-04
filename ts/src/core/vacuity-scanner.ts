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
 *   imported from relative paths, closed over local declarations to a fixpoint
 *   (one helper, or a chain of them, still counts as reaching the target).
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
  rule: 'VAC-001' | 'VAC-002' | 'VAC-003';
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
 */
const JS_LOCAL_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(?:\{([^}]*)\}|\[([^\]]*)\]|(\w+))\s*=)/g;
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
  const own = depth[matches[i]!.index!] ?? 0;
  for (let j = i + 1; j < matches.length; j += 1) {
    const at = matches[j]!.index!;
    if ((depth[at] ?? 0) <= own) return at;
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
 */
function closeOverLocals(
  code: string,
  targets: Set<string>,
  python: boolean,
): Set<string> {
  const decls: { names: string[]; body: string }[] = [];
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
  if (!python) {
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
  }
  const reaching = new Set(targets);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of decls) {
      if (d.names.every((n) => reaching.has(n))) continue;
      const reaches = [...reaching].some((t) =>
        identifierPattern(t).test(d.body),
      );
      if (!reaches) continue;
      for (const n of d.names) reaching.add(n);
      grew = true;
    }
  }
  return reaching;
}

/** Body lines of a test, paired with their 1-based line numbers. */
function bodyLines(
  code: string,
  block: TestBlock,
): { text: string; line: number }[] {
  const first = lineOf(code, block.bodyStart);
  return block.body.split('\n').map((text, i) => ({ text, line: first + i }));
}

function isComment(line: string): boolean {
  const s = line.trim();
  return s.startsWith('#') || s.startsWith('//') || s.startsWith('*');
}

/** The text inside a balanced `expect(...)`, or null. */
function expectArgument(line: string): string | null {
  const open = line.indexOf('expect(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open + 'expect'.length; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')') {
      depth -= 1;
      if (depth === 0) return line.slice(open + 'expect('.length, i);
    }
  }
  return null;
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
 */
function matcherOf(
  line: string,
): { argument: string; negated: boolean } | null {
  const m = /\.\s*(not\s*\.\s*)?to\w+\s*\(([^()]*)\)/.exec(line);
  return m ? { argument: m[2]!, negated: m[1] !== undefined } : null;
}

function normalize(expr: string): string {
  return expr.replace(/\s+/g, '');
}

/** VAC-001 for one JS/TS line. */
function jsTautology(line: string): boolean {
  const actual = expectArgument(line);
  const matcher = matcherOf(line);
  if (actual === null || matcher === null || matcher.negated) return false;
  const a = normalize(actual);
  const e = normalize(matcher.argument);
  if (a === '' || e === '') return false;
  return a === e;
}

/** VAC-001 for one pytest line. */
function pyTautology(line: string): boolean {
  const t = line.trim();
  // `assert False` is a deliberate unreachable marker -- it can only ever fail,
  // so it is the opposite of vacuous and must never be flagged.
  if (/^assert\s+True\s*(?:,|$)/.test(t)) return true;
  // Same reason `.not` is excluded above: `assert x != x` can only ever fail.
  const cmp = /^assert\s+(.+?)\s*==\s*(.+?)\s*(?:,|$)/.exec(t);
  if (!cmp) return false;
  return normalize(cmp[1]!) === normalize(cmp[2]!);
}

function scanBlock(
  code: string,
  block: TestBlock,
  file: string,
  python: boolean,
  reaching: Set<string> | null,
  annotated: string | null,
  skipped: SkipEntry[],
  outOfBand: boolean,
): VacuityFinding[] {
  const lines = bodyLines(code, block).filter((l) => !isComment(l.text));
  const targets = annotated !== null ? new Set([annotated]) : reaching;
  return [
    ...tautologies(lines, block, file, python),
    ...targetNeverInvoked(block, file, reaching, annotated, outOfBand),
    ...absenceOnly(lines, block, file, python, targets, skipped),
  ];
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
  lines: { text: string; line: number }[],
  block: TestBlock,
  file: string,
  python: boolean,
): VacuityFinding[] {
  return lines
    .filter((l) => (python ? pyTautology(l.text) : jsTautology(l.text)))
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

/** VAC-002 -- the target is never referenced anywhere in the body. */
function targetNeverInvoked(
  block: TestBlock,
  file: string,
  reaching: Set<string> | null,
  annotated: string | null,
  outOfBand: boolean,
): VacuityFinding[] {
  if (annotated !== null) {
    if (mentionsAny(block.body, new Set([annotated]))) return [];
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
  // The subprocess / bare-dynamic-import shapes reach first-party code without
  // naming a symbol, so no target set can ever match them (#705).
  if (outOfBand) return [];
  if (reaching === null || mentionsAny(block.body, reaching)) return [];
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
      name: `VAC-003 (${block.name})`,
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
): Set<string> | null {
  const imported = importedTargets(source, python);
  return imported.size > 0 ? closeOverLocals(code, imported, python) : null;
}

/**
 * The `@covers` symbol declared above `block`, or `null`.
 *
 * Two bugs lived in the naive version, and both produced a FALSE BLOCK, which is
 * the worst outcome available here: `annotated` is the one vacuity fidelity
 * allowed to block a promotion, so a stray annotation failed a correct test.
 *
 * - The window was a blind 400-character look-back, so it reached over the
 *   PREVIOUS test and its annotation. It is now floored at `floor` -- the end of
 *   the previous test's body -- so only text genuinely between the two
 *   declarations can be read.
 * - `exec` returns the match nearest the START of the window, i.e. the FARTHEST
 *   annotation above the declaration. It now takes the last, which is the
 *   nearest.
 */
function annotationFor(
  code: string,
  block: TestBlock,
  floor: number,
): string | null {
  const from = Math.max(floor, block.bodyStart - 400);
  const window = code.slice(from, block.bodyStart);
  const matches = [...window.matchAll(COVERS_PRAGMA)];
  return matches.at(-1)?.[1] ?? null;
}

/**
 * Scan one test file for vacuous tests.
 *
 * `checked` counts the tests actually analysed. A file no ruleset can parse
 * yields `checked: 0` plus a skip entry, never an empty finding list that reads
 * as clean.
 */
export function scanVacuity(path: string): GateResult<VacuityFinding> {
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
  const code = blankStringContent(source, { python });
  const blocks = enumerateTests(code, source, python);
  const reaching = resolveTargets(source, code, python);

  const skipped: SkipEntry[] = [];
  const findings = scanAllBlocks(
    { code, source, path, python, reaching },
    blocks,
    skipped,
  );

  const result: GateResult<VacuityFinding> = {
    checked: blocks.length,
    findings,
  };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
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
  reaching: Set<string> | null;
}

function scanAllBlocks(
  ctx: ScanContext,
  blocks: TestBlock[],
  skipped: SkipEntry[],
): VacuityFinding[] {
  const findings: VacuityFinding[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    // An annotation may only be read from the gap between the previous test's
    // end and this declaration -- see `annotationFor`.
    const prev = blocks[i - 1];
    const floor = prev ? prev.bodyStart + prev.body.length : 0;
    const annotated = annotationFor(ctx.code, block, floor);
    const outOfBand =
      !ctx.python &&
      annotated === null &&
      reachesOutOfBandTarget(
        ctx.source.slice(block.bodyStart, block.bodyStart + block.body.length),
      );
    if (annotated === null && ctx.reaching === null) {
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
        name: `${outOfBand ? 'VAC-003' : 'VAC-002/VAC-003'} (${block.name})`,
        reason: outOfBand
          ? 'target reached out of band (subprocess or bare dynamic import), so VAC-002 is answered but no symbol exists for absence-only to observe'
          : 'target unresolvable: no @covers annotation and no first-party relative import to infer from',
      });
    }
    findings.push(
      ...scanBlock(
        ctx.code,
        block,
        ctx.path,
        ctx.python,
        ctx.reaching,
        annotated,
        skipped,
        outOfBand,
      ),
    );
  }
  return findings;
}
