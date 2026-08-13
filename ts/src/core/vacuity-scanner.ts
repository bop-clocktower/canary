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
 *   a finding about the SCAN, so it lands in `skipped` with its reason and the
 *   affected tests never count toward `checked`.
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

/** `@covers <symbol>` -- the explicit rung of the ladder. */
const COVERS_PRAGMA = /@covers\s+([A-Za-z_$][\w$]*)/;

/** An import whose specifier is relative: the local code a test can target. */
const JS_RELATIVE_IMPORT =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+))[^'"]*from\s*['"](\.[^'"]*)['"]/g;
const JS_RELATIVE_REQUIRE =
  /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"](\.[^'"]*)['"]/g;
/**
 * Python has no `.`-prefix requirement for a first-party import, so `from x
 * import y` counts. `import os` and the stdlib are excluded by name below --
 * a heuristic, but the alternative is treating every pytest file as
 * unresolvable.
 */
const PY_FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm;
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

/** Any assertion at all, per language. Deliberately the linter's vocabulary. */
const JS_ASSERTION = /\bexpect\s*\(|\bassert\s*[.(]/;
const PY_ASSERTION = /\bassert\b|\bpytest\.raises\b|\bself\.assert\w+/;

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

/** Names imported from first-party (relative) modules. */
function importedTargets(code: string, python: boolean): Set<string> {
  const names = new Set<string>();
  const addList = (list: string | undefined) => {
    for (const raw of (list ?? '').split(',')) {
      // `{ save as store }` binds `store`; `{ save }` binds `save`.
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  };
  if (python) {
    for (const m of code.matchAll(PY_FROM_IMPORT)) {
      const root = m[1]!.split('.')[0]!;
      if (PY_STDLIB.has(root)) continue;
      addList(m[2]);
    }
    return names;
  }
  for (const re of [JS_RELATIVE_IMPORT, JS_RELATIVE_REQUIRE]) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      addList(m[1]);
      if (m[2]) names.add(m[2]);
    }
  }
  return names;
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
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    const names = boundNames(m, python);
    if (names.length === 0) continue;
    const start = m.index! + m[0].length;
    const end = matches[i + 1]?.index ?? code.length;
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
        new RegExp(`\\b${t}\\b`).test(d.body),
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

/** The single argument of the matcher that follows `expect(...)`, or null. */
function matcherArgument(line: string): string | null {
  const m = /\.\s*(?:not\s*\.\s*)?to\w+\s*\(([^()]*)\)/.exec(line);
  return m ? m[1]! : null;
}

function normalize(expr: string): string {
  return expr.replace(/\s+/g, '');
}

/** VAC-001 for one JS/TS line. */
function jsTautology(line: string): boolean {
  const actual = expectArgument(line);
  const expected = matcherArgument(line);
  if (actual === null || expected === null) return false;
  const a = normalize(actual);
  const e = normalize(expected);
  if (a === '' || e === '') return false;
  return a === e;
}

/** VAC-001 for one pytest line. */
function pyTautology(line: string): boolean {
  const t = line.trim();
  // `assert False` is a deliberate unreachable marker -- it can only ever fail,
  // so it is the opposite of vacuous and must never be flagged.
  if (/^assert\s+True\s*(?:,|$)/.test(t)) return true;
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
): VacuityFinding[] {
  const out: VacuityFinding[] = [];
  const lines = bodyLines(code, block).filter((l) => !isComment(l.text));
  const anyAssertion = python ? PY_ASSERTION : JS_ASSERTION;
  const absence = python ? PY_ABSENCE_ASSERTION : ABSENCE_ASSERTION;

  // VAC-001 -- deterministic, hence `critical`: an expectation identical to the
  // value it checks cannot fail for any implementation.
  for (const l of lines) {
    if (python ? pyTautology(l.text) : jsTautology(l.text)) {
      out.push(
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
  }

  // VAC-002 -- the target is never referenced anywhere in the body.
  if (annotated !== null) {
    if (!new RegExp(`\\b${annotated}\\b`).test(block.body)) {
      out.push(
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
      );
    }
  } else if (reaching !== null) {
    const touches = [...reaching].some((t) =>
      new RegExp(`\\b${t}\\b`).test(block.body),
    );
    if (!touches) {
      out.push(
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
      );
    }
  }

  // VAC-003 -- every assertion is an absence, AND none of them observes the
  // target's own return value.
  //
  // That second clause is not a refinement, it is the rule. The first cut
  // omitted it and reported 254 findings across canary's 2154 tests, nearly all
  // of the form `expect(isCI()).toBe(false)` -- a perfectly good negative test,
  // because the assertion invokes the target, so the target provably ran and the
  // `false` is load-bearing. The #486 katana defect is the other shape:
  // `expect(existsSync(ledger)).toBe(false)` after a bare call, where the
  // absence is observed on a BYSTANDER and the buggy code satisfied it by
  // exiting before the write. Reported at the first absence assertion, the line
  // an author adds a precondition next to.
  const targets = annotated !== null ? new Set([annotated]) : reaching;
  const assertions = lines.filter((l) => anyAssertion.test(l.text));
  const observesTarget = (text: string) =>
    targets !== null &&
    [...targets].some((t) => new RegExp(`\\b${t}\\b`).test(text));
  if (
    targets !== null &&
    assertions.length > 0 &&
    assertions.every((l) => absence.test(l.text)) &&
    !assertions.some((l) => observesTarget(l.text))
  ) {
    out.push(
      mk(
        file,
        assertions[0]!.line,
        'VAC-003',
        'warning',
        block.name,
        'Every assertion in this test asserts an absence, and none of them observes the target.',
        'Add one assertion proving the operation actually ran (exit code, returned value, a positive existence) -- otherwise the test passes identically when the code crashed before doing anything.',
      ),
    );
  }

  return out;
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
    return {
      checked: 0,
      findings: [],
      skipped: [
        {
          name: path,
          reason:
            'no ruleset parses this extension, so a clean result would be meaningless',
        },
      ],
    };
  }
  const python = framework === 'pytest';
  // An unreadable path is the third zero, and it was the worst-shaped one: left
  // to throw, `readFileSync` escaped the command handler, so the CLI printed a
  // raw ENOENT stack and exited **0**. A gate that could not open its input and
  // reported success is precisely the false green this module exists to detect,
  // so "cannot read" becomes an abstention with its cause named -- never an
  // exception, and never a pass.
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      checked: 0,
      findings: [],
      skipped: [
        {
          name: path,
          reason: `could not be read (${(e as { code?: string }).code ?? 'unknown error'})`,
        },
      ],
    };
  }
  // Whole-source blanking, offset-preserving: a `expect(true).toBe(true)`
  // carried as fixture DATA is not a vacuous test, and a `it(...)` inside a
  // string must not be able to truncate a real test's body (#590).
  const code = blankStringContent(source, { python });

  const blocks = enumerateTests(code, source, python);
  const skipped: SkipEntry[] = [];

  // Read imports from the ORIGINAL source, not the blanked copy: blanking
  // replaces literal CONTENT with spaces, so `from './store.js'` becomes
  // `from '           '` and the leading `.` that marks a first-party module is
  // gone -- which silently collapsed every JS/TS file to "target unresolvable".
  //
  // The cost is that an import written inside a fixture string is read as real.
  // That only ever ADDS names to the target set, which makes VAC-002 quieter,
  // never noisier -- the safe direction for a heuristic-tier rule.
  const imported = importedTargets(source, python);
  const reaching =
    imported.size > 0 ? closeOverLocals(code, imported, python) : null;

  const findings: VacuityFinding[] = [];
  for (const block of blocks) {
    const pragma = COVERS_PRAGMA.exec(
      // The annotation sits in a comment ABOVE the declaration, so look back to
      // the previous newline-delimited comment run rather than into the body.
      code.slice(Math.max(0, block.bodyStart - 400), block.bodyStart),
    );
    const annotated = pragma?.[1] ?? null;
    if (annotated === null && reaching === null) {
      // Both target-dependent rules go dark together, and both say so. VAC-003
      // asks "does any assertion observe the target", which is unanswerable
      // without a target -- so it abstains rather than falling back to the
      // 254-false-positive version of itself.
      skipped.push({
        name: `VAC-002/VAC-003 (${block.name})`,
        reason:
          'target unresolvable: no @covers annotation and no first-party relative import to infer from',
      });
    }
    findings.push(...scanBlock(code, block, path, python, reaching, annotated));
  }

  const result: GateResult<VacuityFinding> = {
    checked: blocks.length,
    findings,
  };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}
