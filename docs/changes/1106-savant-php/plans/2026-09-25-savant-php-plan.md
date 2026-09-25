# Plan: canary-savant PHP support (#1106)

**Date:** 2026-09-25 | **Spec:** `docs/changes/1106-savant-php/proposal.md` |
**Tasks:** 15 | **Time:** ~62 min | **Integration Tier:** medium | **Rigor:**
standard | **Branch:** `feat/1106-savant-php` (worktree
`/Users/bs/Github/canary-fleet-1106-savant-php`)

## Goal

`canary-savant`'s static pass (SV001–SV004) reads PHPUnit and WordPress test
files. It flags PHP shared-state smells and stays silent on the restore, pair
and read shapes. Python and JS behaviour is unchanged, and the perf and entropy
ratchets gain no new finding identity.

## Observable Truths (Acceptance Criteria)

Each truth has an ID. The Traceability table at the end maps each ID to its
task.

- **OT1** (event, spec SC1). When a directory walk meets `FooTest.php`,
  `test-foo.php`, or any `.php` under `tests/`, the system shall scan it. It
  shall not walk `src/Foo.php` or `plugin/helper.php`, and it shall never walk
  anything under `vendor/`. A `.php` path named on the command line is always
  scanned.
- **OT2** (event, SC2 and D7). When a `.php` file writes a superglobal (a keyed
  element, a nested element, `[]=`, a compound op, or a whole reassign), or
  calls `putenv('K=v')`, `ini_set`, `date_default_timezone_set`, `define`,
  `add_filter`/`add_action`, or `update_option`/`add_option` with no restore,
  the system shall report `SV003-shared-singleton-mutation` on that line.
- **OT3** (unwanted, SC2 and D8). If the same key is restored inside a
  `tearDown*`, `tear_down*` or `wpTearDown*` body (Allman or same-line brace) or
  inside a `finally {}`, then the system shall not report the write. The
  restores are: `unset`, a whole-family reassign, `putenv('K')`, `ini_restore`,
  `ini_set` again, `delete_option`, and the same setter again. A snapshot
  write-back line (`$_SERVER = $saved;` after `$saved = $_SERVER;`) shall not be
  reported either.
- **OT4** (ubiquitous, SC4 and D7). The system shall report every `define()`
  call, even when a teardown mentions the same constant. `defined(`, `->define(`
  and `::define(` never match.
- **OT5** (event, D8). When an `add_filter`/`add_action` has a matching
  `remove_filter`, `remove_action`, `remove_all_filters` or `remove_all_actions`
  for the same hook on any code line of the file, the system shall not report
  it. A commented-out remove, a remove for another hook, or an `add_*` inside
  `tearDown` does not pair.
- **OT6** (state, SC5 and D9). While a file declares
  `class X extends WP_*UnitTestCase*` on a code line, the system shall treat
  hook and option mutations as restored. It shall still report a superglobal
  write that has no restore.
- **OT7** (event, D4). When a `.php` file declares a column-0 `$x = [` or
  `array(`, a `static $x` (local or
  `public|protected|private static [?type] $x`) or a `global $a, $b;`, and some
  code line mutates that variable in place, the system shall report
  `SV001-module-mutable-global` once on the declaration line. In-place means
  `[..]=`, `[]=`, a compound op, `++`/`--`,
  `array_push/unshift/splice/pop/shift(`, or `->prop =`. A plain reassign, a
  read, or a write to `$xy` shall not count. Superglobals and `$GLOBALS` are
  SV003-only.
- **OT8** (event, D6). When a `.php` file contains `function setUpBeforeClass(`,
  or `set_up_before_class(` and the code-only projection lacks the matching
  teardown name, the system shall report `SV002-missing-teardown`. Per-test
  `setUp`/`set_up` never fire.
- **OT9** (event, D10). When a code line (not a string) declares
  `function testFirst(`/`testLast(`/`testFinal(`, `function test_first(`, or
  `function test_1_…`, the system shall report `SV004-order-coupled-name`.
  `testFirstMatchWins`, `test_firstname` and `test_10ms` stay silent.
- **OT10** (unwanted, SC3). If a PHP token appears only in a whole-line comment
  (`//`, `#`, `/* */`, `*`) or inside a string literal, then the system shall
  not report it.
- **OT11** (ubiquitous, SC6). JS and Python files never see a PHP family. A JS
  `define([...])` and a Python `os.putenv('A=1')` stay silent. Every existing
  savant suite stays green, and `string-literals.mjs` is byte-identical (its
  parity test is green).
- **OT12** (SC7). Every new code path has a planted positive. Breaking it turns
  a named test red, and restoring it turns the test green again.
- **OT13** (CI trap). `savant … ts/test agents/skills/test --strict` and
  `blackhawk … ts/test agents/skills/test --strict` both exit 0, with a non-zero
  files-scanned count.
- **OT14** (ratchets). `harness check-perf` reports no new
  `(file, rule, subject)` identity under `canary-savant/scripts/`.
  `restoration.mjs` and `rules.mjs` each stay at 299 lines or fewer. The entropy
  finding count equals the merge-base count.
- **OT15** (docs). `SKILL.md` names PHPUnit/WordPress in its description, rules
  table, framework conditioning, fidelity limits and suffix list. `CHANGELOG.md`
  has an Unreleased entry. The four gates pass.

## Assumptions (autonomous lane: recommended defaults, not asked)

1. **PHP families are language-gated.** Each PHP `SINGLETON_FAMILIES` entry
   carries `php: true`, and `familiesFor(isPhp)` filters them out for non-PHP
   files. `classifyMutation(line, ranges, isPhp = false)` and
   `analyzeRestoration(text, isPhp = false)` take a new optional flag, and
   existing callers are unchanged. _Why:_ without the gate, AMD `define([...])`
   in a JS test would fire an unrestorable SV003, which breaks SC6.
2. **No separate `collectPhpRegions` function.** The existing brace-balanced
   finally collector already does the job. It gains two optional parameters,
   `re` and `[open, close]`. PHP teardown bodies are one more call with
   `PHP_TEARDOWN_FN`, and the JS `afterEach`/`afterAll` collector becomes a
   `'()'` call of the same function. `collectJsRegions` is deleted. The name
   `collectJsFinallyRegions` is kept on purpose (see assumption 3).
3. **Line-budget refactors are in scope.** They preserve behaviour and are
   covered by the existing restoration suite. Measured in a detached worktree of
   this branch, a naive `restoration.mjs` lands at 321–328 lines. That adds a
   NEW `File has N lines (threshold: 300)` identity, and the perf delta rule
   (`scripts/lib/perf-findings.mjs`, identity = file+rule+subject) turns it red,
   with no `--admin` escape. The plan therefore:
   - folds `collectJsRegions` into the finally collector (assumption 2);
   - rewrites `collectPyRegions` as a table (`PY_SCOPED` + `addIndentScope`);
   - merges the region-restore loop into one `recordRestores` helper;
   - moves PHP regex constants and `familiesFor` into `rules.mjs`.

   Measured result: `restoration.mjs` 295 lines, `rules.mjs` 289 lines, and
   savant perf findings 212 → 210 (the `collectPyRegions` complexity and
   `collectJsFinallyRegions` nesting findings are paid down). No new identities.

4. **Per-language dispatch table in `scanner.mjs`.** `LANGS` holds `py`, `js`
   and `php`, each with `pairs`, `setupHit` and `sv001`, and replaces the `isPy`
   ternaries. _Why:_ `scanTextFull` sits at cyclomatic 12 (warning). Adding
   `isPhp` branches risks crossing 15, which moves it to the error band and
   creates a new identity. Measured after the change: it stays at 12.
5. **SV001 PHP reads the code-only projection** (`codeOnly`, #732) for both the
   declaration and the mutation. JS and Python keep today's raw-text
   `mutationPattern` check unchanged.
6. **The column-0 declaration is opener-based** (`$x = [` or `$x = array(`).
   Multi-line PHP array literals are idiomatic, and a closer-required pattern
   would miss them. Names starting `_[A-Z]` and `GLOBALS` are excluded (D5).
7. **A `global $a, $b;` line fires at most once** when any of its names is
   mutated in place. This matches the one-finding-per-declaration rule.
8. **WP base detection is class-anchored**
   (`^\s*(abstract|final|readonly )*class X extends \?WP_\w*UnitTestCase\w*`),
   so a comment never turns auto-restore on. An intermediate custom base
   (`extends My_TestCase`) is not followed. It fires, which is the safe
   direction.
9. **Hook pairing ignores whole-line comments** (`COMMENT_LINE`). This applies
   to the file-wide pairAnywhere path only. Region-restore handling for JS and
   Python is unchanged, so commented restores inside `afterEach` still count, as
   they do today.
10. **SV004's camelCase alternative is `test_?(ordinal)` under the existing `/i`
    flag.** It also newly fires on a JS `function testFirst(` and a Python
    `def testFirst(`. That is the same smell. A grep of `ts/`, `agents/` and
    `npm/` found no existing hits, so strict CI is unaffected.
11. **In-test snapshot semantics match JS.** With `$saved = $_SERVER;` →
    `$_SERVER['HTTPS'] = 'on';` → `$_SERVER = $saved;` in one test body, the
    write-back line is silent and the HTTPS write still fires (no
    teardown/finally region). This is the existing #493 behaviour.

## Uncertainties

- [ASSUMPTION] The perf CI job uses the same `harness check-perf` identities
  measured locally in a detached worktree (CLI 12.10.1, Node 22.23.2). If CI
  differs, Task 14 catches it before push.
- [ASSUMPTION] PHPUnit `backupGlobals` (phpunit.xml or `#[BackupGlobals]`)
  restores superglobals too, but it is invisible to a file scan. Superglobal
  writes in such suites will be advisory false positives. This goes under
  SKILL.md fidelity limits, not code.
- [ASSUMPTION, amended at APPROVE_PLAN] `wpSetUpBeforeClass` is NOT an SV002
  setup marker. WP's base `tear_down_after_class` already deletes the
  factory-created data it exists to build, so pairing it would make the
  framework's own idiom the dominant PHP SV002 false positive. Spec D6 updated.
- [DEFERRABLE] `--confirm` on a `.php` target. `detectFramework` returns `null`
  only when no `vitest.config.*`/pytest marker exists in cwd. In a WordPress
  plugin repo with a vitest config, `--confirm` on `.php` paths would run
  vitest. Out of scope (spec); Task 12 pins the null case and documents the
  limit.
- [DEFERRABLE] Exact SKILL.md wording.

## Evidence (file:line, current `main` 6cd6e0c9)

- `scanner.mjs:36-44` `SUPPORTED_SUFFIXES` (no `.php`); `:46-64` `SKIP_DIRS`;
  `:78-87` `isTestFile`; `:168-193` `sv002MissingTeardown` (`isPy` ternaries);
  `:239-280` `scanTextFull` (cyclomatic 12, warning band).
- `restoration.mjs:76-81` `keyOf` (the `match.length > 2` heuristic would
  misread putenv's two groups); `:89-100` `classifyMutation`; `:147-168`
  `collectJsRegions`; `:170-193` `collectJsFinallyRegions` (nesting 5);
  `:196-227` `collectPyRegions` (cyclomatic 14); `:234-274` `analyzeRestoration`
  (cyclomatic 14). The file is 274 lines.
- `rules.mjs:64-92` `SINGLETON_FAMILIES`; `:102-103` `SV004_CODE_PATTERN`. The
  file is 168 lines.
- `.github/workflows/harness-quality.yml:475-482`: both detectors run `--strict`
  over `ts/test agents/skills/test`.
- `runner.mjs:112-143` `detectFramework`.
- A dry run in a throwaway detached worktree (removed) of the exact code below:
  the new test file gave 120/120 green, and 72 of those tests are red against
  current `main`. All 20 planted positives in this plan turned a test red.
  Savant/blackhawk strict exit 0 (268 files). Typecheck and format:check are
  clean.

## File Map

- MODIFY `agents/skills/claude-code/canary-savant/scripts/scanner.mjs` (suffix,
  vendor, `isTestFile`, `LANGS`/`langOf`, `sv002` by lang, PHP SV001, `isPhp`
  wiring)
- MODIFY `agents/skills/claude-code/canary-savant/scripts/rules.mjs` (PHP
  families, `familiesFor`, `PHP_TEARDOWN_FN`, `COMMENT_LINE`,
  `WP_TESTCASE_BASE`, `PHP_SETUP_TEARDOWN`, PHP SV001 regexes,
  `phpMutationPattern`, SV004 pattern)
- MODIFY `agents/skills/claude-code/canary-savant/scripts/restoration.mjs`
  (`keyOf(match, family)`, `classifyMutation` `isPhp`, parameterised brace/paren
  collector, table-driven Python regions, `recordRestores`, `familyVerdict`,
  `analyzeRestoration` `isPhp`)
- CREATE `agents/skills/test/canary-savant.php.test.ts`
- MODIFY `agents/skills/claude-code/canary-savant/SKILL.md`
- MODIFY `CHANGELOG.md`
- UNCHANGED (asserted):
  `agents/skills/claude-code/canary-savant/scripts/string-literals.mjs`,
  everything under `canary-blackhawk/`, `harness.config.json` (no `entryPoints`
  change), `.harness/perf-baseline.json`, `.harness/entropy-baseline.json`

## Skeleton

1. Discovery and language dispatch (~2 tasks, ~8 min)
2. Line-budget refactor of restoration (~1 task, ~4 min)
3. SV003 families, wiring, regions, policy, WP (~5 tasks, ~22 min)
4. SV001 and SV004 (~2 tasks, ~9 min)
5. CI trap, docs, changelog (~3 tasks, ~10 min)
6. Ratchet verification and four gates (~2 tasks, ~9 min)

_Skeleton approved: auto (autonomous fleet lane, recommended default)._

## Conventions for every task

- Work only in `/Users/bs/Github/canary-fleet-1106-savant-php`. Start each shell
  with
  `cd /Users/bs/Github/canary-fleet-1106-savant-php && eval "$(mise env -s zsh)"`
  (Node 22.23.2).
- Test command:
  `cd agents/skills && npx vitest run test/canary-savant.php.test.ts`.
  Regression: add
  `test/canary-savant.static.test.ts test/canary-savant.restoration.test.ts`.
- **Fixtures:** every PHP line is its own single-line string, and fixtures are
  arrays joined with `'\n'` through the helpers. Never use a multi-line template
  literal. Single-line template literals (`` `    ${stmt}` ``) are fine. Test
  titles must not contain `run first`, `runs before`, `must run` … (SV004 text
  pattern).
- **PLANTED POSITIVE:** make the named edit, run the named test, see it go red,
  revert the edit exactly, and see it go green. Never commit a plant.
- Before each commit, run `npx prettier --write <touched files>` (from
  `agents/skills`, repo `.prettierrc` applies), then `harness validate`.
- Commit with `git commit -m "<msg>"`. Conventional Commits, no co-author
  trailer, never `--no-verify`, no bare `-n` on the command line.

## Tasks

### Task 1: Scan `.php` test files, skip `vendor/`

**Depends on:** none | **Files:**
`agents/skills/test/canary-savant.php.test.ts`,
`agents/skills/claude-code/canary-savant/scripts/scanner.mjs`

1. Create `agents/skills/test/canary-savant.php.test.ts`:

   ```ts
   // canary-savant PHP support (#1106): PHPUnit and WordPress idioms for the
   // static pass (SV001-SV004). Spec: docs/changes/1106-savant-php/proposal.md.
   //
   // CI TRAP: savant and blackhawk scan THIS file with --strict. Every PHP
   // fixture line is its own single-line string literal, joined with '\n'. A
   // multi-line template literal's continuation lines would read as CODE and
   // fire on canary's own suite.

   import { describe, it, expect } from 'vitest';
   import fs from 'node:fs';
   import os from 'node:os';
   import path from 'node:path';

   import {
     scanText,
     scanPaths,
   } from '../claude-code/canary-savant/scripts/scanner.mjs';

   // Braced bodies on purpose (see canary-savant.restoration.test.ts, #495).
   const php = (...lines: string[]) => {
     return ['<?php', ...lines].join('\n');
   };

   // --- Test-file discovery (D11) ---------------------------------------------

   function withTree(files: string[], fn: (root: string) => void) {
     const root = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-php-'));
     try {
       for (const rel of files) {
         const full = path.join(root, rel);
         fs.mkdirSync(path.dirname(full), { recursive: true });
         fs.writeFileSync(full, php('echo 1;'));
       }
       fn(root);
     } finally {
       fs.rmSync(root, { recursive: true, force: true });
     }
   }

   describe('PHP test-file discovery (#1106 D11)', () => {
     it('walks FooTest.php, test-foo.php and .php under tests/, nothing else', () => {
       const files = [
         'plugin/FooTest.php',
         'plugin/test-foo.php',
         'tests/unit/Bar.php',
         'src/Foo.php',
         'plugin/helper.php',
       ];
       withTree(files, (root) => {
         expect(scanPaths([root]).filesScanned).toBe(3);
       });
     });

     it('never walks vendor/, even its test files', () => {
       const files = [
         'vendor/acme/tests/VendorTest.php',
         'vendor/acme/a.test.js',
       ];
       withTree(files, (root) => {
         expect(scanPaths([root]).filesScanned).toBe(0);
       });
     });

     it('scans a .php file named explicitly, whatever its name', () => {
       withTree(['src/Foo.php'], (root) => {
         const file = path.join(root, 'src', 'Foo.php');
         expect(scanPaths([file]).filesScanned).toBe(1);
       });
     });
   });
   ```

   (`scanText` is imported now and first used in Task 2.)

2. Run the test and observe **3 failures**: the walk scans 0, `vendor/a.test.js`
   scans 1, and the explicit path scans 0.
3. In `scanner.mjs`:
   - Add `'.php',` as the last entry of `SUPPORTED_SUFFIXES`.
   - Add this after `'.tox',` in `SKIP_DIRS`:

     ```js
       'vendor', // Composer's node_modules (#1106)
     ```

   - In `isTestFile`, add this after the `test_`/`_test` line:

     ```js
     // PHPUnit FooTest.php, WordPress test-foo.php (#1106 D11).
     if (suffix === '.php' && /^test-|Test$/.test(stem)) return true;
     ```

4. Run the test and observe green (3/3). Run the regression suites and observe
   green.
5. **PLANTED POSITIVES:**
   - (a) Remove `'.php',` from `SUPPORTED_SUFFIXES`. The walk and explicit tests
     go red. Restore them.
   - (b) Remove the `'vendor'` line. The vendor test goes red (1 ≠ 0). Restore
     it.
6. Prettier, then `harness validate`.
7. Commit:
   `feat(savant): scan PHPUnit and WordPress test files, skip vendor (#1106)`

### Task 2: Per-language dispatch table and SV002 PHP pairs

**Depends on:** Task 1 | **Files:** `rules.mjs`, `scanner.mjs`,
`canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   // Line 1 `<?php`, line 2 the class head, line 3 `{`, body from line 4.
   const inClass = (
     body: string[],
     head = 'class FooTest extends TestCase',
   ) => {
     return php(head, '{', ...body, '}');
   };
   // `line:rule` pairs, e.g. ['4:SV003'], so every assertion pins the line.
   const hits = (text: string, name = 'FooTest.php') => {
     return scanText(text, name).map(
       (f) => `${f.line}:${f.ruleId.slice(0, 5)}`,
     );
   };

   // --- SV002 (D6) ------------------------------------------------------------

   describe('SV002 PHP class-scoped pairs (#1106 D6)', () => {
     it.each([
       ['setUpBeforeClass', 'tearDownAfterClass'],
       ['set_up_before_class', 'tear_down_after_class'],
     ])('%s without %s fires; with it, silent', (setup, teardown) => {
       const up = `    public static function ${setup}(): void {}`;
       const down = `    public static function ${teardown}(): void {}`;
       expect(hits(inClass([up]))).toEqual(['4:SV002']);
       expect(hits(inClass([up, down]))).toEqual([]);
     });

     it.each(['setUp', 'set_up'])('per-test %s alone is silent', (setup) => {
       expect(
         hits(inClass([`    protected function ${setup}(): void {}`])),
       ).toEqual([]);
     });

     it('a setup named only in a comment or a string does not fire', () => {
       const body = [
         '    // public static function setUpBeforeClass(): void {}',
         "    private $doc = 'function setUpBeforeClass()';",
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a teardown named only in a comment does not pair', () => {
       const body = [
         '    public static function setUpBeforeClass(): void {}',
         '    // tearDownAfterClass() is inherited',
       ];
       expect(hits(inClass(body))).toEqual(['4:SV002']);
     });
   });
   ```

2. Run the test and observe red: the three `%s without %s` cases and the
   comment-pair case (`.php` currently gets the JS `beforeAll` pairs).
3. In `rules.mjs`, add this directly after
   `export const JS_SETUP_TEARDOWN = [['beforeAll', 'afterAll']];`:

   ```js
   // PHPUnit, then WP_UnitTestCase's snake_case spelling (#1106 D6).
   // wpSetUpBeforeClass is deliberately absent: WP's base class deletes the
   // factory data it builds, so it never needs its own teardown.
   export const PHP_SETUP_TEARDOWN = [
     ['setUpBeforeClass', 'tearDownAfterClass'],
     ['set_up_before_class', 'tear_down_after_class'],
   ];
   ```

4. In `scanner.mjs`:
   - Add `PHP_SETUP_TEARDOWN,` to the `./rules.mjs` import, after
     `JS_SETUP_TEARDOWN,`.
   - Insert this directly above
     `/** Setup markers whose matching teardown is absent from the file. */`:

     ```js
     // Per-language rule inputs (#1106): one table instead of isPy/isPhp branches,
     // so scanTextFull's complexity does not grow with each language.
     const LANGS = {
       py: {
         pairs: PYTHON_SETUP_TEARDOWN,
         setupHit: (code, setup) => code.includes(`def ${setup}`),
         sv001: (lines, file, text) =>
           sv001ModuleMutables(lines, file, true, text),
       },
       js: {
         pairs: JS_SETUP_TEARDOWN,
         setupHit: (code, setup) =>
           code.startsWith(`${setup}(`) || code.includes(` ${setup}(`),
         sv001: (lines, file, text) =>
           sv001ModuleMutables(lines, file, false, text),
       },
       php: {
         pairs: PHP_SETUP_TEARDOWN,
         setupHit: (code, setup) => code.includes(`function ${setup}(`),
         // Today's (JS-mode) SV001 until Task 9 adds the PHP pass.
         sv001: (lines, file, text) =>
           sv001ModuleMutables(lines, file, false, text),
       },
     };
     const langOf = (file) => {
       if (file.endsWith('.py')) return 'py';
       return file.endsWith('.php') ? 'php' : 'js';
     };
     ```

   - `sv002MissingTeardown`: change the signature to
     `function sv002MissingTeardown(lines, file, lang) {`, and replace
     `const pairs = isPy ? PYTHON_SETUP_TEARDOWN : JS_SETUP_TEARDOWN;` with
     `const { pairs, setupHit } = LANGS[lang];`. Replace the
     `const hit = isPy ? … : …;` / `if (hit) {` lines with
     `if (setupHit(code, setup)) {`.
   - `scanTextFull`: replace `const isPy = file.endsWith('.py');` with
     `const lang = langOf(file);`. Replace the two `findings.push(...)` lines
     with:

     ```js
     findings.push(...LANGS[lang].sv001(lines, file, text));
     findings.push(...sv002MissingTeardown(lines, file, lang));
     ```

5. Run the test and observe green, and the regression suites green (the Python
   and JS SV001/SV002 tests pin the refactor).
6. **PLANTED POSITIVES:**
   - (a) Set `php.setupHit` to `() => false`. The four SV002 PHP tests go red.
     Restore it.
   - (b) Set `js.setupHit` to `() => false`. The static suite's
     `flags vitest beforeAll with no afterAll` goes red. Restore it.
7. Prettier, then `harness validate`.
8. Commit: `feat(savant): SV002 PHP class-scoped setup/teardown pairs (#1106)`

### Task 3: Line-budget refactor of the region collectors (no behaviour change)

**Depends on:** none | **Files:** `restoration.mjs`

_Why:_ Task 6–8 additions push `restoration.mjs` past the 300-line perf
threshold. That adds a new identity, and the delta rule fails CI. See
Assumptions 2–3. Existing tests are the safety net.

1. Run the regression suites and observe green (baseline).
2. Delete `collectJsRegions` (its JSDoc through its closing `}`). Replace
   `collectJsFinallyRegions`'s JSDoc, signature, and first two body lines up to
   `if (!token) return;` with:

   ```js
   /**
    * Balanced bodies opened at `re`, string-aware: `finally { ... }` (#733) by
    * default, afterEach/afterAll call parens, and PHP teardown methods (#1106).
    * Counting starts at the token's last char, never the line start (`} finally
    * {` opens with the TRY block's `}`), and runs on to the first opener, so an
    * Allman brace on the next line works. Capped if unclosed.
    */
   function collectJsFinallyRegions(
     lines,
     rangesByLine,
     region,
     re = JS_FINALLY,
     [open, close] = '{}',
   ) {
     lines.forEach((line, i) => {
       const token = execOutsideStrings(re, line, rangesByLine[i]);
       if (!token) return;
   ```

   Delete the two-line `// Count from the finally's own …` comment. In the inner
   loop, change `text[k] === '{'` to `text[k] === open` and `text[k] === '}'` to
   `text[k] === close`.

3. Replace the whole `collectPyRegions` function (JSDoc included) with:

   ```js
   // Python regions are indentation-scoped, as [opener, strict]: a def/finally
   // body is indented DEEPER than its opener; post-yield code may share it.
   const PY_SCOPED = [
     [PY_TEARDOWN_DEF, true],
     [PY_YIELD, false],
     [PY_FINALLY, true], // #733
   ];

   /** Add the lines after `i` that stay inside an indentation scope. */
   function addIndentScope(lines, i, indent, strict, region) {
     for (let j = i + 1; j < lines.length; j += 1) {
       const depth = indentOf(lines[j]);
       const inside = depth > indent || (!strict && depth === indent);
       if (!isBlank(lines[j]) && !inside) return;
       region.add(j);
     }
   }

   /** Python: teardown def bodies, post-yield code, addCleanup lines. */
   function collectPyRegions(lines, rangesByLine, region) {
     lines.forEach((line, i) => {
       for (const [opener, strict] of PY_SCOPED) {
         const m = opener.exec(line);
         if (m) addIndentScope(lines, i, m[1].length, strict, region);
       }
       if (execOutsideStrings(/\baddCleanup\b/, line, rangesByLine[i])) {
         region.add(i);
       }
     });
   }
   ```

4. In `analyzeRestoration`, replace
   `collectJsRegions(lines, rangesByLine, region);` with
   `collectJsFinallyRegions(lines, rangesByLine, region, JS_TEARDOWN_TOKEN, '()');`.
5. Run the regression suites and observe green, with the same test count as
   step 1.
6. **PLANTED POSITIVES:**
   - (a) Delete the `JS_TEARDOWN_TOKEN, '()'` call. The restoration suite's
     `analyzeRestoration (JS)` afterEach/afterAll tests go red (8). Restore it.
   - (b) Change `[PY_YIELD, false]` to `[PY_YIELD, true]`.
     `code after a fixture yield is teardown` goes red. Restore it.
   - (c) Change `depth > indent` to `depth >= indent`.
     `teardown ends at dedent…` goes red. Restore it.
7. Prettier, then `harness validate`.
8. Commit: `refactor(savant): share one balanced-region collector (#1106)`

### Task 4: PHP singleton families and language gating

**Depends on:** Task 3 | **Files:** `rules.mjs`, `restoration.mjs`,
`canary-savant.php.test.ts`

1. Add
   `import { classifyMutation } from '../claude-code/canary-savant/scripts/restoration.mjs';`
   and
   `import { stringLiteralRanges } from '../claude-code/canary-savant/scripts/string-literals.mjs';`
   to the test file imports. Append:

   ```ts
   // --- SV003 families (D7) ---------------------------------------------------

   const classifyPhp = (line: string) => {
     return classifyMutation(line, stringLiteralRanges(line), true);
   };

   describe('classifyMutation: PHP families (#1106 D7)', () => {
     it.each([
       ["$_GET['q'] = 'x';", '$_GET', 'q'],
       ["$_SERVER['HTTP_HOST'] = 'example.org';", '$_SERVER', 'HTTP_HOST'],
       ["$_SESSION['a']['b'] = 1;", '$_SESSION', 'a'],
       ["$_COOKIE['c'] .= 'x';", '$_COOKIE', 'c'],
       ["$_REQUEST['r'] ??= 1;", '$_REQUEST', 'r'],
       ['$_FILES[] = $upload;', '$_FILES', null],
       ['$_POST = [];', '$_POST', null],
       ["$_ENV['APP_ENV'] = 'test';", '$_ENV', 'APP_ENV'],
       ["$GLOBALS['wp_rewrite'] = null;", '$GLOBALS', 'wp_rewrite'],
       ["putenv('APP_ENV=test');", 'putenv', 'APP_ENV'],
       ["ini_set('precision', '4');", 'ini_set', 'precision'],
       ["date_default_timezone_set('UTC');", 'date_default_timezone_set', null],
       ["define('WP_DEBUG', true);", 'define', 'WP_DEBUG'],
       [
         "add_filter('the_title', '__return_empty_string');",
         'wp.hooks',
         'the_title',
       ],
       ["add_action( 'init', 'boot' );", 'wp.hooks', 'init'],
       ["update_option('blogname', 'x');", 'wp.options', 'blogname'],
       ["add_option('k', 1);", 'wp.options', 'k'],
     ])('classifies %s as %s', (line, family, key) => {
       expect(classifyPhp(line)).toMatchObject({ family, key });
     });

     it.each([
       "if ($_GET['q'] == 'x') {}",
       "$same = $_GET['q'] === 'x';",
       "$q = $_GET['q'];",
       "$pairs = [$_GET['q'] => 1];",
       '$_GETX = 1;',
       "if (!defined('WP_DEBUG')) {}",
       "$this->define('X', 1);",
       "Foo::define('X', 1);",
       "$v = get_option('blogname');",
     ])('returns null for the read or comparison %s', (line) => {
       expect(classifyPhp(line)).toBeNull();
     });

     it('never applies a PHP family outside .php (a JS define( is AMD)', () => {
       const lines = [
         "define(['dep'], factory);",
         "$_GET['q'] = 1;",
         "add_filter('x', cb);",
       ];
       for (const line of lines) {
         expect(classifyMutation(line, stringLiteralRanges(line))).toBeNull();
       }
     });
   });
   ```

2. Run the test and observe the 17 `classifies` cases red (`null`).
3. In `rules.mjs`, insert this block directly **above** the existing
   `// SV003: singleton / env mutation …` comment:

   ```js
   // PHP families (#1106) carry `php: true` and apply to .php files only (a JS
   // `define(` is AMD, not a constant). Optional fields: `keyOf(match)` when the
   // key is not group 1; `unrestorable` (no restore launders it); `pairAnywhere`
   // (a delete ANYWHERE in the file restores: WP's inline add_filter ...
   // remove_filter); `wpAutoRestored` (a WP_UnitTestCase base restores it).
   // PHP_ASSIGN is plain or compound (.= += ??= ...), never `==`/`===`/`=>`.
   const PHP_OP = String.raw`(?:\.|\?\?|\*\*|<<|>>|[-+*/%&|^])`;
   const PHP_ASSIGN = String.raw`\s*${PHP_OP}?=(?![=>])`;
   // $_GET['k'] = | $_GET['k']['n'] .= | $_GET[] = | $_GET = ... (group 1: key)
   const superglobal = (name) => ({
     id: `$${name}`,
     token: String.raw`\$${name}`,
     php: true,
     assign: new RegExp(
       String.raw`(?<![\w$])\$${name}\b\s*(?:\[([^\]]*)\](?:\s*\[[^\]]*\])*)?` +
         PHP_ASSIGN,
     ),
     deletes: [
       new RegExp(String.raw`\bunset\s*\(\s*\$${name}\b\s*\[([^\]]*)\]`),
     ],
     restoreAll: [],
   });
   const phpCall = (id, assign, deletes, extra = {}) => ({
     id,
     token: id,
     php: true,
     assign,
     deletes,
     restoreAll: [],
     ...extra,
   });
   const PHP_FAMILIES = [
     ...[
       '_GET',
       '_POST',
       '_COOKIE',
       '_SERVER',
       '_ENV',
       '_SESSION',
       '_REQUEST',
       '_FILES',
       'GLOBALS',
     ].map(superglobal),
     // putenv('NAME=v') sets; putenv('NAME') (no `=`) unsets, i.e. restores.
     phpCall(
       'putenv',
       /\bputenv\s*\(\s*(['"])([^'"=]+)=/,
       [/\bputenv\s*\(\s*(['"])([^'"=]+)\1\s*\)/],
       { keyOf: (m) => m[2] },
     ),
     phpCall('ini_set', /\bini_set\s*\(\s*([^,)]+)/, [
       /\bini_restore\s*\(\s*([^,)]+)/,
     ]),
     phpCall(
       'date_default_timezone_set',
       /\bdate_default_timezone_set\s*\(/,
       [],
     ),
     // A PHP constant can never be undefined. `defined(` does not match.
     phpCall('define', /(?<![\w$>:])define\s*\(\s*([^,)]+)/, [], {
       unrestorable: true,
     }),
     phpCall(
       'wp.hooks',
       /\badd_(?:filter|action)\s*\(\s*([^,)]+)/,
       [/\bremove_(?:filter|action|all_filters|all_actions)\s*\(\s*([^,)]+)/],
       { pairAnywhere: true, wpAutoRestored: true },
     ),
     phpCall(
       'wp.options',
       /\b(?:update|add)_option\s*\(\s*([^,)]+)/,
       [/\bdelete_option\s*\(\s*([^,)]+)/],
       { wpAutoRestored: true },
     ),
   ];
   ```

   Add `...PHP_FAMILIES,` as the last element of `SINGLETON_FAMILIES` (after the
   `sys.modules` entry). Directly after the array's closing `];`, add:

   ```js
   // SV003 restore context for PHP (#1106), read by restoration.mjs.
   export const familiesFor = (isPhp) =>
     SINGLETON_FAMILIES.filter((family) => isPhp || !family.php);
   ```

4. In `restoration.mjs`, change the rules import to
   `import { SINGLETON_FAMILIES, familiesFor } from './rules.mjs';`. Then:
   - Make `keyOf` take the family: `function keyOf(match, family) {`, with first
     line
     `if (family.keyOf) return family.keyOf(match); // putenv NAME= (#1106)`.
   - Add `@param {boolean} [isPhp] include the PHP families (#1106)` to the
     `classifyMutation` JSDoc. Make it
     `export function classifyMutation(line, ranges, isPhp = false) {` and loop
     `for (const family of familiesFor(isPhp)) {`, with
     `key: keyOf(match, family),`.
   - In `analyzeRestoration`'s region loop, change
     `record(family.id, keyOf(match));` to
     `record(family.id, keyOf(match, family));`.
5. Run the test and observe green. Run the regression suites and observe green.
6. **PLANTED POSITIVES:**
   - (a) Change `PHP_OP}?=(?![=>])` to `PHP_OP}?=`. The `==`/`===`/`=>` null
     cases go red (5). Restore it.
   - (b) Make `familiesFor` return `SINGLETON_FAMILIES.filter(() => true)`. The
     gating test goes red. Restore it.
   - (c) Delete the `family.keyOf` line in `keyOf`. The putenv case goes red
     (key `'`). Restore it.
7. Prettier, then `harness validate`, then `wc -l rules.mjs restoration.mjs`.
8. Commit: `feat(savant): PHP and WordPress singleton families (#1106)`

### Task 5: Wire PHP into the SV003 line pass

**Depends on:** Task 2, Task 4 | **Files:** `scanner.mjs`,
`canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   describe('SV003 PHP in the scanner (#1106)', () => {
     it('a superglobal write with no restore fires on its line', () => {
       const body = [
         '    public function test_a(): void',
         '    {',
         "        $_GET['q'] = 'x';",
         '    }',
       ];
       expect(hits(inClass(body))).toEqual(['6:SV003']);
     });

     it.each([
       "$_SERVER['X'] .= 'y';",
       '$_SESSION[] = 1;',
       '$_POST = [];',
       "define('FOO', 1);",
       "putenv('APP_ENV=test');",
       "ini_set('precision', '4');",
       "date_default_timezone_set('UTC');",
       "add_filter('the_title', 'x');",
       "update_option('blogname', 'x');",
     ])('%s with no restore fires', (stmt) => {
       expect(hits(inClass([`        ${stmt}`]))).toEqual(['4:SV003']);
     });

     it('a restore in a finally block is silent', () => {
       const body = [
         '    public function test_a(): void',
         '    {',
         '        try {',
         "            $_GET['q'] = 'x';",
         '        } finally {',
         "            unset($_GET['q']);",
         '        }',
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('the snapshot write-back line itself is silent', () => {
       const body = [
         '    public function test_a(): void',
         '    {',
         '        $saved = $_SERVER;',
         "        $_SERVER['HTTPS'] = 'on';",
         '        $_SERVER = $saved;',
         '    }',
       ];
       // Only the HTTPS write (line 7); the write-back on line 8 is the restore.
       expect(hits(inClass(body))).toEqual(['7:SV003']);
     });

     it('reads and comparisons never fire', () => {
       const body = [
         "        $q = $_GET['q'];",
         "        if ($_GET['q'] === 'x') {}",
         "        if (!defined('X')) {}",
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a token in a comment never fires', () => {
       const body = [
         "        // $_GET['q'] = 'x';",
         "        # putenv('A=1');",
         "        /* define('X', 1); */",
         "         * add_filter('a', 'b');",
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a token in a string never fires', () => {
       const body = [
         '        $s = "$_GET[\'q\'] = 1";',
         '        $t = \'putenv("A=1")\';',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('JS and Python files keep ignoring PHP tokens', () => {
       expect(hits("define(['a'], function (a) {});", 'a.test.js')).toEqual([]);
       expect(hits("$_GET['q'] = 1;", 'a.test.js')).toEqual([]);
       expect(hits("os.putenv('A=1')", 'test_a.py')).toEqual([]);
     });
   });
   ```

2. Run the test and observe red: every "fires" case, since the scanner never
   passes `isPhp`.
3. In `scanner.mjs` `scanTextFull`, add `const isPhp = lang === 'php';` after
   `const lang = langOf(file);`. Change
   `const restoration = analyzeRestoration(text);` to
   `analyzeRestoration(text, isPhp);` (the argument takes effect in Task 6), and
   `classifyMutation(stripped, ranges)` to
   `classifyMutation(stripped, ranges, isPhp)`.
4. Run the test and observe green. Run the regression suites and observe green.
5. **PLANTED POSITIVE:** revert `classifyMutation(stripped, ranges, isPhp)` to
   `(stripped, ranges)`. The SV003 scanner tests go red. Restore it.
6. Prettier, then `harness validate`.
7. Commit:
   `feat(savant): report PHP singleton mutations in the SV003 line pass (#1106)`

### Task 6: PHP teardown-method regions

**Depends on:** Task 5 | **Files:** `rules.mjs`, `restoration.mjs`,
`canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   // --- SV003 restore evidence (D8) -------------------------------------------

   describe('SV003 PHP teardown regions (#1106 D8)', () => {
     it('an unset in tearDown (Allman brace) restores the key', () => {
       const body = [
         "    public function test_a(): void { $_GET['q'] = 'x'; }",
         '    protected function tearDown(): void',
         '    {',
         "        unset($_GET['q']);",
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a whole-family reassign in tear_down restores every key', () => {
       const body = [
         "    public function test_a() { $_COOKIE['c'] = 1; }",
         '    public function tear_down() {',
         '        $_COOKIE = [];',
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('wpTearDownAfterClass is a teardown region', () => {
       const body = [
         "    public static function wpSetUpBeforeClass() { $GLOBALS['x'] = 1; }",
         '    public static function wpTearDownAfterClass() {',
         "        unset($GLOBALS['x']);",
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a restore of a different key leaves the write flagged', () => {
       const body = [
         "    public function test_a() { $_GET['a'] = 1; }",
         '    protected function tearDown(): void {',
         "        unset($_GET['b']);",
         '    }',
       ];
       expect(hits(inClass(body))).toEqual(['4:SV003']);
     });

     it('the region ends at the method close brace', () => {
       const body = [
         '    protected function tearDown(): void {',
         '        parent::tearDown();',
         '    }',
         "    public function test_a() { $_GET['a'] = 1; }",
       ];
       expect(hits(inClass(body))).toEqual(['7:SV003']);
     });

     it('a bodiless abstract teardown opens no region', () => {
       const text = php(
         'abstract class BaseTest extends TestCase',
         '{',
         '    abstract protected function tearDownFixture(): void;',
         "    public function helper() { unset($_GET['a']); }",
         "    public function test_a() { $_GET['a'] = 1; }",
         '}',
       );
       expect(hits(text, 'BaseTest.php')).toEqual(['6:SV003']);
     });

     it('a teardown token inside a string opens no region', () => {
       const body = [
         "    private $doc = 'function tearDown() {';",
         "    public function helper() { unset($_GET['a']); }",
         "    public function test_a() { $_GET['a'] = 1; }",
       ];
       expect(hits(inClass(body))).toEqual(['6:SV003']);
     });

     it.each([
       ["putenv('APP_ENV=test');", "putenv('APP_ENV');"],
       ["ini_set('precision', '4');", "ini_restore('precision');"],
       ["ini_set('precision', '4');", "ini_set('precision', $this->old);"],
       [
         "date_default_timezone_set('UTC');",
         'date_default_timezone_set($this->tz);',
       ],
       ["update_option('blogname', 'x');", "delete_option('blogname');"],
       ["$_SERVER['HTTPS'] = 'on';", '$_SERVER = $this->server;'],
     ])('%s is restored by %s in tearDown', (write, restore) => {
       const body = [
         `    public function test_a() { ${write} }`,
         '    protected function tearDown(): void {',
         `        ${restore}`,
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });
   });
   ```

2. Run the test and observe red: the restore cases fire, because `tearDown` is
   not yet a region.
3. In `rules.mjs`, add this directly after the `familiesFor` export:

   ```js
   // A teardown method; the lookahead skips a bodiless `...(): void;` declaration.
   export const PHP_TEARDOWN_FN =
     /\bfunction\s+(?:tear_?down\w*|wpTearDown\w*)\s*\((?![^{]*;\s*$)/i;
   ```

4. In `restoration.mjs`:
   - Import `PHP_TEARDOWN_FN` alongside `familiesFor`.
   - Header: after the paragraph starting `// Teardown regions:`, add
     `// PHP (#1106): tearDown*/tear_down*/wpTearDown* bodies are regions too; see`
     and
     `// rules.mjs for the unrestorable, pairAnywhere and wpAutoRestored families.`
   - `analyzeRestoration`: add the JSDoc line
     `@param {boolean} [isPhp] enable the PHP families and regions (#1106)`,
     change the signature to
     `export function analyzeRestoration(text, isPhp = false) {`, and add this
     after `collectPyRegions(lines, rangesByLine, region);`:

     ```js
     if (isPhp) {
       collectJsFinallyRegions(lines, rangesByLine, region, PHP_TEARDOWN_FN);
     }
     ```

   - In its region loop, change `for (const family of SINGLETON_FAMILIES) {` to
     `for (const family of familiesFor(isPhp)) {`.
5. Run the test and observe green. Run the regression suites and observe green.
6. **PLANTED POSITIVES:**
   - (a) Delete the `if (isPhp) { … }` block. The region tests go red (9).
     Restore it.
   - (b) Remove `(?![^{]*;\s*$)` from `PHP_TEARDOWN_FN`. The abstract test goes
     red. Restore it.
7. Prettier, then `harness validate`.
8. Commit: `feat(savant): PHP teardown method bodies restore SV003 (#1106)`

### Task 7: File-wide WordPress hook pairing

**Depends on:** Task 6 | **Files:** `rules.mjs`, `restoration.mjs`,
`canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   describe('SV003 PHP restore policy (#1106 D7/D8)', () => {
     it.each([
       ["add_filter('the_title', 'x');", "remove_filter('the_title', 'x');"],
       ["add_action('init', 'boot');", "remove_action('init', 'boot');"],
       ["add_filter('the_title', 'x');", "remove_all_filters('the_title');"],
       ["add_action('init', 'boot');", "remove_all_actions('init');"],
     ])('%s is paired by %s anywhere in the file', (add, remove) => {
       const body = [
         '    public function test_a(): void',
         '    {',
         `        ${add}`,
         '        $this->assertTrue(true);',
         `        ${remove}`,
         '    }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a remove for another hook leaves the add flagged', () => {
       const body = [
         "        add_action('init', 'boot');",
         "        remove_action('wp_head', 'boot');",
       ];
       expect(hits(inClass(body))).toEqual(['4:SV003']);
     });

     it('a commented-out remove_filter does not pair', () => {
       const body = [
         "        add_filter('the_title', 'x');",
         "        // remove_filter('the_title', 'x');",
       ];
       expect(hits(inClass(body))).toEqual(['4:SV003']);
     });

     it('an add_filter inside tearDown is not its own restore', () => {
       const body = [
         '    protected function tearDown(): void {',
         "        add_filter('a', 'b');",
         '    }',
       ];
       expect(hits(inClass(body))).toEqual(['5:SV003']);
     });
   });
   ```

2. Run the test and observe red: the four pairing cases, and add-in-tearDown
   (the add currently restores itself).
3. In `rules.mjs`, add this after `PHP_TEARDOWN_FN`:

   ```js
   // A whole-line comment: a remove_filter() there is prose, not a pairing.
   export const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*)/;
   ```

4. In `restoration.mjs`, import `COMMENT_LINE`. Insert this function directly
   above the `analyzeRestoration` JSDoc:

   ```js
   /**
    * Record restores (#493): a family's idioms inside a teardown region, plus
    * (#1106) a pairAnywhere family's deletes on any code line of the file.
    */
   function recordRestores(lines, rangesByLine, region, isPhp, record) {
     const families = familiesFor(isPhp);
     lines.forEach((line, i) => {
       const inRegion = region.has(i);
       const code = !COMMENT_LINE.test(line);
       for (const family of families) {
         const paired = family.pairAnywhere; // add_filter never restores itself
         const patterns = [
           ...(inRegion && !paired
             ? [family.assign, ...family.restoreAll]
             : []),
           ...(inRegion || (code && paired) ? family.deletes : []),
         ];
         for (const pattern of patterns) {
           for (const m of execAllOutsideStrings(
             pattern,
             line,
             rangesByLine[i],
           )) {
             record(family.id, keyOf(m, family)); // restoreAll: no group -> null
           }
         }
       }
     });
   }
   ```

   In `analyzeRestoration`, delete the whole `for (const i of region) { … }`
   loop and put `recordRestores(lines, rangesByLine, region, isPhp, record);` in
   its place, right after the `record` closure.

5. Run the test and observe green. Run the regression suites and observe green.
   `restoreAll` now records via `keyOf`, which returns `null` for a group-less
   match, the same as before.
6. **PLANTED POSITIVES:**
   - (a) Change `inRegion || (code && paired)` to `inRegion || paired`. The
     commented-remove test goes red. Restore it.
   - (b) Change `inRegion && !paired ?` to `inRegion ?`. The add-in-tearDown
     test goes red. Restore it.
   - (c) Change `inRegion || (code && paired)` to `inRegion`. The pairing tests
     go red. Restore it.
7. Prettier, `harness validate`, then `wc -l restoration.mjs` (≤ 299).
8. Commit: `feat(savant): pair WordPress hooks with a file-wide remove (#1106)`

### Task 8: Family verdicts: unrestorable `define`, WP_UnitTestCase auto-restore

**Depends on:** Task 7 | **Files:** `rules.mjs`, `restoration.mjs`,
`canary-savant.php.test.ts`

1. Append this `it` to the `SV003 PHP restore policy` describe (as its first
   test), and append the new describe after it:

   ```ts
   it('define fires even when a teardown redefines it (unrestorable)', () => {
     const body = [
       "    public function test_a() { define('FOO', 1); }",
       '    protected function tearDown(): void {',
       "        define('FOO', 2);",
       '    }',
     ];
     expect(hits(inClass(body))).toEqual(['4:SV003', '6:SV003']);
   });
   ```

   ```ts
   describe('WP_UnitTestCase auto-restore (#1106 D9)', () => {
     const wp = 'class Tests_Foo extends WP_UnitTestCase';

     it('hooks and options are restored by the framework', () => {
       const body = [
         "        add_filter('the_title', 'x');",
         "        update_option('blogname', 'x');",
       ];
       expect(hits(inClass(body, wp))).toEqual([]);
     });

     it('superglobals are NOT restored by the framework', () => {
       expect(hits(inClass(["        $_GET['a'] = 1;"], wp))).toEqual([
         '4:SV003',
       ]);
     });

     it.each([
       'class Tests_Foo extends \\WP_UnitTestCase',
       'class Tests_Ajax extends WP_Ajax_UnitTestCase',
       'class Tests_Base extends WP_UnitTestCase_Base',
       'abstract class Tests_Base extends WP_UnitTestCase',
     ])('%s counts as a WP base', (head) => {
       expect(
         hits(inClass(["        add_action('init', 'boot');"], head)),
       ).toEqual([]);
     });

     it('a base named only in a comment does not count', () => {
       const text = php(
         '// class Old extends WP_UnitTestCase',
         'class FooTest extends TestCase',
         '{',
         "    public function test_a() { add_filter('a', 'b'); }",
         '}',
       );
       expect(hits(text)).toEqual(['5:SV003']);
     });
   });
   ```

2. Run the test and observe red: `define` returns `[]` (the tearDown define
   "restores" it), and the WP-base silence cases fire.
3. In `rules.mjs`, add this after `COMMENT_LINE`:

   ```js
   // A class extending a WP_*UnitTestCase* base (D9): the framework restores
   // hooks and rolls the DB back per test. Class-anchored, so a comment can't.
   export const WP_TESTCASE_BASE =
     /^\s*(?:(?:abstract|final|readonly)\s+)*class\s+\w+\s+extends\s+\\?WP_\w*UnitTestCase\w*\b/;
   ```

4. In `restoration.mjs`, import `WP_TESTCASE_BASE`. Insert this directly above
   the `analyzeRestoration` JSDoc:

   ```js
   /** A family-level verdict that overrides key evidence, else null (#1106). */
   function familyVerdict(familyId, wpAuto) {
     const family = SINGLETON_FAMILIES.find((f) => f.id === familyId);
     if (family?.unrestorable) return false;
     if (wpAuto && family?.wpAutoRestored) return true;
     return null;
   }
   ```

   In `analyzeRestoration`, after the `recordRestores(…)` call:

   ```js
   // D9: a WP_UnitTestCase base restores hooks and rolls back the DB.
   const wpAuto = isPhp && lines.some((l) => WP_TESTCASE_BASE.test(l));
   ```

   and make `restores` begin with:

   ```js
   const verdict = familyVerdict(familyId, wpAuto);
   if (verdict !== null) return verdict;
   ```

5. Run the test and observe green. Run the regression suites and observe green.
6. **PLANTED POSITIVES:**
   - (a) Delete `if (family?.unrestorable) return false;`. The define test goes
     red. Restore it.
   - (b) Change `const wpAuto = isPhp && lines…` to
     `const wpAuto = false && lines…`. The WP tests go red (5). Restore it.
   - (c) Replace the `WP_TESTCASE_BASE` anchor
     `/^\s*(?:(?:abstract|final|readonly)\s+)*class\s+\w+\s+extends` with
     `/\bextends`. The comment test goes red. Restore it.
7. Prettier, `harness validate`, then `wc -l restoration.mjs rules.mjs` (each ≤
   299; the measured draft was 295 / 289).
8. Commit: `feat(savant): define() never restores; WP_UnitTestCase does (#1106)`

### Task 9: SV001 PHP declarations

**Depends on:** Task 2, Task 8 | **Files:** `rules.mjs`, `scanner.mjs`,
`canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   // --- SV001 (D4) ------------------------------------------------------------

   describe('SV001 PHP declarations (#1106 D4)', () => {
     it.each([
       '$seen[] = 1;',
       "$seen['k'] = 1;",
       "$seen['a']['b'] = 1;",
       "$seen .= 'x';",
       '$seen += [1];',
       '$seen ??= [];',
       '$seen++;',
       '++$seen;',
       '$seen--;',
       'array_push($seen, 1);',
       'array_unshift($seen, 1);',
       'array_splice($seen, 0, 1);',
       'array_pop($seen);',
       'array_shift($seen);',
       "$seen->name = 'x';",
     ])('a local static mutated by %s fires on its declaration', (stmt) => {
       const body = [
         '    public function test_a(): void',
         '    {',
         '        static $seen = [];',
         `        ${stmt}`,
         '    }',
       ];
       expect(hits(inClass(body))).toEqual(['6:SV001']);
     });

     it('a typed static property written through self:: fires', () => {
       const body = [
         '    protected static ?array $seen = null;',
         '    public function test_a(): void { self::$seen[] = 1; }',
       ];
       expect(hits(inClass(body))).toEqual(['4:SV001']);
     });

     it('a read-only or plainly reassigned static is silent', () => {
       const body = [
         '    private static $fixture = null;',
         '    public static function setUpBeforeClass(): void { self::$fixture = 1; }',
         '    public static function tearDownAfterClass(): void { self::$fixture = null; }',
         '    public function test_a(): void { $this->assertSame(1, self::$fixture); }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a static method is not a static variable', () => {
       const body = [
         '    public static function build(): array { return []; }',
         '    public function test_a(): void { $build[] = 1; }',
       ];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a global accumulator appended to fires on the global line', () => {
       const text = php(
         'function test_it() {',
         '    global $log;',
         "    $log[] = 'x';",
         '}',
       );
       expect(hits(text, 'test-log.php')).toEqual(['3:SV001']);
     });

     it('global $wpdb used for a query is silent', () => {
       const text = php(
         'function test_it() {',
         '    global $wpdb;',
         "    $wpdb->query('SELECT 1');",
         '}',
       );
       expect(hits(text, 'test-db.php')).toEqual([]);
     });

     it('a global line naming several mutated vars fires once', () => {
       const text = php(
         'function test_it() {',
         '    global $wp_query, $post;',
         "    $post->post_title = 'x';",
         '    $wp_query->is_404 = true;',
         '}',
       );
       expect(hits(text, 'test-query.php')).toEqual(['3:SV001']);
     });

     it.each([
       ['$registry = [];', "    $registry['a'] = 1;"],
       ['$registry = array();', '    array_push($registry, 1);'],
     ])('a column-0 %s mutated in a function fires', (decl, mutate) => {
       const text = php(decl, 'function test_it() {', mutate, '}');
       expect(hits(text, 'test-registry.php')).toEqual(['2:SV001']);
     });

     it('a column-0 array that is only read is silent', () => {
       const text = php(
         "$map = ['a' => 1];",
         'function test_it() {',
         "    return $map['a'] === 1;",
         '}',
       );
       expect(hits(text, 'test-map.php')).toEqual([]);
     });

     it('$x is not indicted by writes to $xy', () => {
       const text = php(
         '$x = [];',
         'function test_it() {',
         "    $xy['a'] = 1;",
         '    ++$xy;',
         '    array_push($xy, 1);',
         '}',
       );
       expect(hits(text, 'test-x.php')).toEqual([]);
     });

     it('an indented array is local, not module scope', () => {
       const text = php(
         'function test_it() {',
         '    $local = [];',
         "    $local['a'] = 1;",
         '}',
       );
       expect(hits(text, 'test-local.php')).toEqual([]);
     });

     it('a mutation only in a comment or a string does not indict', () => {
       const text = php('$x = [];', "// $x['a'] = 1;", '$s = "$x[] = 1";');
       expect(hits(text, 'test-x.php')).toEqual([]);
     });

     it('a superglobal at column 0 is SV003 only, never SV001', () => {
       const text = php('$_GET = [];', "$_GET['a'] = 1;", "$GLOBALS['x'] = 1;");
       expect(hits(text, 'test-g.php')).toEqual([
         '2:SV003',
         '3:SV003',
         '4:SV003',
       ]);
     });
   });
   ```

2. Run the test and observe red: every "fires" case, since `.php` still uses the
   JS-mode SV001.
3. In `rules.mjs`, add this after `JS_MODULE_MUTABLE`:

   ```js
   // PHP (#1106), NAME captured without `$`; superglobals are SV003's (D5).
   //   column-0  $x = [ ...  |  $x = array( ...
   export const PHP_MODULE_MUTABLE =
     /^\$(?!_[A-Z]|GLOBALS\b)(\w+)\s*=\s*(?:\[|array\s*\()/;
   //   static $x  |  public static ?array $x   (local or class property)
   export const PHP_STATIC_DECL =
     /^\s*(?:(?:public|protected|private|final|readonly)\s+)*static\s+(?:\??[\w\\|]+\s+)?\$(\w+)/;
   //   global $a, $b;
   export const PHP_GLOBAL_DECL = /^\s*global\s+(\$\w+(?:\s*,\s*\$\w+)*)\s*;/;
   ```

   Append this at the end of the file (after `mutationPattern`):

   ```js
   /**
    * PHP (#1106): an in-place mutation of `$name` - `$x[..] =`, `$x[] =`,
    * compound assignment, `++`/`--`, array_push/unshift/splice/pop/shift, or
    * `$x->prop =`. A plain `$x = ...` is not one: it is also how a restore is
    * written. `(?<![\w$])` and `\b` keep `$x` from matching `$xy`.
    * @param {string} name the variable, without `$`
    * @returns {RegExp}
    */
   export function phpMutationPattern(name) {
     const v = String.raw`(?<![\w$])\$${escapeRe(name)}\b`;
     const index = String.raw`\s*\[[^\]]*\]`;
     return new RegExp(
       `${v}(?:${index})+${PHP_ASSIGN}` +
         `|${v}\\s*${PHP_OP}=(?![=>])` +
         `|${v}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${v}` +
         `|\\barray_(?:push|unshift|splice|pop|shift)\\s*\\(\\s*${v}` +
         `|${v}\\s*->\\s*\\w+(?:${index})*${PHP_ASSIGN}`,
     );
   }
   ```

4. In `scanner.mjs`, add `PHP_MODULE_MUTABLE, PHP_STATIC_DECL, PHP_GLOBAL_DECL,`
   and `phpMutationPattern,` to the rules import. Insert this directly above
   `// Line comment openers, for the code-only projection below.`:

   ```js
   /** PHP variable names (no `$`) a code line declares as shared (#1106 D4). */
   function phpDeclaredNames(code) {
     const names = [];
     const moduleLevel = PHP_MODULE_MUTABLE.exec(code); // anchored at column 0
     if (moduleLevel) names.push(moduleLevel[1]);
     const stat = PHP_STATIC_DECL.exec(code);
     if (stat) names.push(stat[1]);
     const glob = PHP_GLOBAL_DECL.exec(code);
     if (glob) names.push(...glob[1].split(',').map((v) => v.trim().slice(1)));
     return names;
   }

   /**
    * PHP SV001: a column-0 array, a `static $x` or a `global $x` import fires on
    * its declaration line when the file mutates that variable in place. Both
    * halves read the code-only projection, so comments and strings never count.
    */
   function sv001PhpMutables(lines, file) {
     const codeLines = lines.map(codeOnly);
     const codeText = codeLines.join('\n');
     const findings = [];
     codeLines.forEach((code, i) => {
       const names = phpDeclaredNames(code);
       if (names.some((n) => phpMutationPattern(n).test(codeText))) {
         const snippet = lines[i].trim();
         findings.push(
           makeFinding(file, i + 1, 'SV001-module-mutable-global', snippet),
         );
       }
     });
     return findings;
   }
   ```

   In `LANGS.php`, replace the interim comment and `sv001` line with
   `sv001: (lines, file) => sv001PhpMutables(lines, file),`.

5. Run the test and observe green. Run the regression suites and observe green.
6. **PLANTED POSITIVES:**
   - (a) Set `LANGS.php.sv001` to `() => []`. The SV001 fire tests go red (20).
     Restore it.
   - (b) Drop the trailing `\b` from `v` in `phpMutationPattern`. The `$x`/`$xy`
     test goes red. Restore it.
   - (c) Remove `(?!_[A-Z]|GLOBALS\b)` from `PHP_MODULE_MUTABLE`. The
     superglobal test goes red. Restore it.
   - (d) Remove the `|${v}\\s*${PHP_OP}=(?![=>])` alternative. The `.=`, `+=`
     and `??=` cases go red. Restore it.
7. Prettier, `harness validate`, then `harness check-deps`.
8. Commit: `feat(savant): SV001 PHP arrays, statics and globals (#1106)`

### Task 10: SV004 PHP ordinal test names

**Depends on:** Task 1 | **Files:** `rules.mjs`, `canary-savant.php.test.ts`

1. Append to the test file:

   ```ts
   // --- SV004 (D10) -----------------------------------------------------------

   describe('SV004 PHP ordinal test names (#1106 D10)', () => {
     it.each([
       'testFirst',
       'testLast',
       'testFinal',
       'test_first',
       'test_1_boots',
     ])('function %s fires', (name) => {
       const body = [`    public function ${name}(): void {}`];
       expect(hits(inClass(body))).toEqual(['4:SV004']);
     });

     it.each([
       'testFirstMatchWins',
       'test_firstname',
       'testLastModifiedHeader',
       'test_10ms',
     ])('function %s is silent', (name) => {
       const body = [`    public function ${name}(): void {}`];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('an ordinal name inside a string is data', () => {
       const body = ["    private $n = 'function testFirst()';"];
       expect(hits(inClass(body))).toEqual([]);
     });

     it('a JS function testFirst fires too', () => {
       expect(hits('function testFirst() {}', 'a.test.js')).toEqual([
         '1:SV004',
       ]);
     });
   });
   ```

2. Run the test and observe red (the five fire cases and the JS case).
3. In `rules.mjs`, replace the first two alternatives of `SV004_CODE_PATTERN`,
   `/\bdef\s+test_\d+_|\bdef\s+test_(?:first|`, with
   `/\b(?:def|function)\s+test_\d+_|\b(?:def|function)\s+test_?(?:first|`. The
   rest of the literal stays unchanged. Add this comment line under
   `//   def test_first / test_last(_more) …`:
   `//   function test_1_... | function testFirst(  -> PHP spellings (#1106)`.
4. Run the test and observe green. Run the regression suites and observe green.
5. **PLANTED POSITIVE:** change `test_?(?:first` back to `test_(?:first`. The
   camelCase cases go red (4). Restore it.
6. Prettier, then `harness validate`.
7. Commit: `feat(savant): SV004 PHP ordinal test names (#1106)`

### Task 11: CI-trap check: strict dogfood over canary's own suites

**Depends on:** Tasks 1–10 | **Files:** none (verification only;
`[checkpoint:human-verify]` if either exit is non-zero)

1. From the repo root:

   ```bash
   node agents/skills/claude-code/canary-savant/scripts/cli.mjs ts/test agents/skills/test --strict > /tmp/sv-1106.out; echo "savant rc=$?"
   node agents/skills/claude-code/canary-blackhawk/scripts/cli.mjs ts/test agents/skills/test --strict > /tmp/bh-1106.out; echo "blackhawk rc=$?"
   tail -2 /tmp/sv-1106.out /tmp/bh-1106.out
   ```

   Do not pipe before reading `$?`. Expect `rc=0` for both, with a non-zero
   `files scanned` (the dry run showed 268 each). A zero count is an abstention,
   not a pass.

2. If either exits 1, the finding is in `canary-savant.php.test.ts`. Fix the
   fixture (a multi-line literal, or an SV004 phrase in a title). Never add a
   `savant-ignore`.
3. Confirm that this diff is empty:

   ```bash
   git diff --stat main -- \
     agents/skills/claude-code/canary-savant/scripts/string-literals.mjs \
     agents/skills/claude-code/canary-blackhawk
   ```

   Also confirm that `npx vitest run test/string-literals.test.ts` (from
   `agents/skills`) is green.
4. No commit (nothing changed). If step 2 changed the test file, commit
   `test(savant): keep PHP fixtures single-line for the strict dogfood gate (#1106)`.

### Task 12: SKILL.md for PHP, plus a pin on the `--confirm` decline

**Depends on:** Task 11 | **Files:**
`agents/skills/claude-code/canary-savant/SKILL.md`, `canary-savant.php.test.ts`
| **Category:** integration

1. Add
   `import { detectFramework } from '../claude-code/canary-savant/scripts/runner.mjs';`
   to the test file imports, and append:

   ```ts
   describe('--confirm declines PHP (#1106, out of scope)', () => {
     it('detectFramework returns null for a PHP-only target', () => {
       const options = { readdir: () => ['FooTest.php'], exists: () => false };
       expect(detectFramework(['tests/FooTest.php'], options)).toBeNull();
     });
   });
   ```

   Run it and observe green: this pins existing behaviour the docs will claim.
   **PLANTED POSITIVE:** add
   `if (paths.some((p) => p.endsWith('.php'))) return 'vitest';` as the first
   line of `detectFramework`. The test goes red. Revert it.

2. Edit `SKILL.md`:
   - **Frontmatter description:** replace
     `Advisory by default; pytest and vitest idioms.` with
     `Advisory by default; pytest, vitest and PHPUnit/WordPress idioms.`
     `ts/test/discovery-tree-integrity.test.ts` only requires a non-empty
     description; no test pins its text or length.
   - **Rules table:** append these sentences to the end of each row's "Fires on"
     cell. Keep each row on one line; prettier re-pads the table.

     ```markdown
     SV001: PHP: a column-0 `$x = [` / `array(`, a `static $x` (local or class
     property) or a `global $x` import, fired when the file mutates it in place
     (`[]=`, `[..] =`, `.=`/`+=`/`??=`, `++`/`--`, `array_push`/`array_shift`/…,
     `->prop =`). A plain reassign never counts. SV002: PHP: PHPUnit
     `setUpBeforeClass`/`tearDownAfterClass`, WordPress
     `set_up_before_class`/`tear_down_after_class` (`wpSetUpBeforeClass` is
     excluded: the WP base class deletes its factory data); per-test
     `setUp`/`set_up` are excluded. SV003: PHP: superglobal writes (`$_GET`,
     `$_POST`, `$_COOKIE`, `$_SERVER`, `$_ENV`, `$_SESSION`, `$_REQUEST`,
     `$_FILES`, `$GLOBALS`), `putenv`, `ini_set`, `date_default_timezone_set`,
     `define` (never suppressed: a constant cannot be undefined), and WordPress
     `add_filter`/`add_action` and `update_option`/`add_option`. Restores are
     `unset`, a family reassign, `putenv('K')`, `ini_restore` and
     `delete_option` in a `tearDown*`/`tear_down*`/`wpTearDown*` body or a
     `finally`, plus a matching `remove_filter`/`remove_action`/`remove_all_*`
     anywhere in the file. SV004: PHP: `function testFirst()`,
     `function test_first()`, `function test_1_…`.
     ```

   - **Framework conditioning:** add a sentence: `.php` files are read with
     PHPUnit/WordPress markers. In a class that `extends` a `WP_*UnitTestCase*`
     base, hook and option mutations count as restored (the framework backs up
     and restores hooks and rolls back the DB per test); superglobals do not.
   - **Fidelity limits:** add these bullets:
     - PHP heredoc/nowdoc bodies and multi-line calls are line-scoped like every
       other multi-line construct. Continuation lines read as code.
     - `$old = ini_set('k', 'v')` (inline capture) is not recognised as a
       restore on its own; the restore must be spelled out in teardown.
     - An intermediate custom base
       (`extends My_TestCase extends WP_UnitTestCase`) is not followed, so hooks
       there still fire.
     - PHPUnit `backupGlobals` (phpunit.xml or attribute) is invisible to a file
       scan, so superglobal writes in such suites can be false suspects.
     - A trailing comment on a code line is not stripped for SV003, the same as
       JS and Python today.
     - `--confirm` has no PHPUnit runner: a `.php` target declines as
       `unknown_framework`. If the working directory holds a `vitest.config.*`
       or pytest marker, framework detection falls back to it, so pass JS/Python
       paths only.
   - **Which files get scanned:** add `*Test.php` and `test-*.php`, add `.php`
     to the suffix list, and add `vendor` to the dependency directories.
   - **Confirming pass:** add one sentence saying PHP targets decline (see
     fidelity limits).
3. Run
   `npx prettier --write agents/skills/claude-code/canary-savant/SKILL.md agents/skills/test/canary-savant.php.test.ts`,
   then `node scripts/check_doc_fences.mjs` (exit 0), then `harness validate`.
   Doc links are checked by `ts/test/doc-links.test.ts` in Task 15.
4. Commit:
   `docs(savant): document PHPUnit and WordPress support and its limits (#1106)`

### Task 13: CHANGELOG entry

**Depends on:** Task 12 | **Files:** `CHANGELOG.md` | **Category:** integration

1. Under `## [Unreleased]` → `### Added`, insert this as the first bullet:

   ```markdown
   - **canary-savant reads PHP** (#1106). The static pass now scans PHPUnit
     (`*Test.php`) and WordPress (`test-*.php`) files and skips `vendor/`. SV003
     catches superglobal writes, `putenv`, `ini_set`,
     `date_default_timezone_set`, `define` (never suppressed) and WordPress
     hooks and options, and recognises their restores in `tearDown`/`tear_down`
     or `finally`, a matching `remove_filter` anywhere in the file, and a
     `WP_UnitTestCase` base's own hook/option restore. SV001 catches
     `static`/`global`/column-0 arrays mutated in place, SV002 the class-scoped
     PHPUnit and WordPress setup pairs, and SV004 `function testFirst()`.
     `--confirm` still declines PHP.
   ```

2. Run `npx prettier --write CHANGELOG.md`, then `harness validate`.
3. Commit: `docs(changelog): canary-savant PHP support (#1106)`

### Task 14: Ratchet verification in a fresh worktree

**Depends on:** Task 13 | **Files:** none (measurement only) |
`[checkpoint:human-verify]` on any new identity

1. `wc -l agents/skills/claude-code/canary-savant/scripts/{rules,restoration}.mjs`,
   and confirm each is ≤ 299.
2. Measure perf in a fresh detached worktree (the shared tree reads high, #700):

   Mirror the CI step (`harness-quality.yml` "Performance ratchet"): text
   reports, no narrowing flag, and both roots handed over explicitly.

   ```bash
   git fetch origin
   T="${TMPDIR:-/tmp}"; HEADWT="$T/savant-1106-head"; BASEWT="$T/savant-1106-base"
   git worktree add --detach "$HEADWT" HEAD
   git worktree add --detach "$BASEWT" "$(git merge-base HEAD origin/main)"
   (cd "$HEADWT" && harness check-perf > "$T/perf-head.txt" 2>&1)
   (cd "$BASEWT" && harness check-perf > "$T/perf-base.txt" 2>&1)
   node scripts/perf-ratchet.mjs --report "$T/perf-head.txt" --cli-version "$(harness --version)" --report-root "$HEADWT" --base-report "$T/perf-base.txt" --base-report-root "$BASEWT"; echo "perf rc=$?"
   grep 'canary-savant/scripts' "$T/perf-head.txt"
   ```

   Expect `perf rc=0` with no new identity under `canary-savant/scripts/`. Exit
   3 is an abstention; investigate it, never accept it. The dry run measured 212
   → 210 total, with only magnitude growth (advisory) on `scanner.mjs` file
   length (375 → ~440) and `scanTextFull` length (59 → 60).

3. Entropy: run `harness cleanup --findings-json > "$T/ent-head.txt"` in
   `$HEADWT`, and the same to `ent-base.txt` in `$BASEWT`. Confirm the
   `Entropy issues: N` head count ≤ the base count (the dry run gave 143 = 143).
   No new `.mjs` module means no `entryPoints` change.
4. `git worktree remove --force "$HEADWT" && git worktree remove --force "$BASEWT"`.
5. If a new identity appears, stop. Do not raise a ceiling or add a
   `deltaAllowance`; restructure the offending function under the same name.

### Task 15: Four gates

**Depends on:** Task 14 | **Files:** none

1. `cd agents/skills && npm test && npm run typecheck && npm run format:check`.
   Check each exit code separately, and confirm the coverage thresholds hold
   (90/90/85/90).
2. `cd ts && npm run build && npm run typecheck && npm run format:check && npm test`
   (ts/ has no `lint` script).
3. `harness validate && harness check-deps` from the root.
4. Self-review `git diff main` as a reviewer, with the rule-8 questions: which
   docs does this change make wrong, and which behaviour is untested?
5. Nothing to commit unless a gate forced a fix. Any fix gets its own
   Conventional Commit.

## Traceability

| Truth | Tasks                              |
| ----- | ---------------------------------- |
| OT1   | 1                                  |
| OT2   | 4, 5                               |
| OT3   | 5 (finally, write-back), 6         |
| OT4   | 4, 8                               |
| OT5   | 7                                  |
| OT6   | 8                                  |
| OT7   | 9                                  |
| OT8   | 2                                  |
| OT9   | 10                                 |
| OT10  | 2, 5, 6, 9, 10                     |
| OT11  | 3, 4, 5, 10, 11                    |
| OT12  | every task's PLANTED POSITIVE step |
| OT13  | 11                                 |
| OT14  | 3, 7, 8, 14                        |
| OT15  | 12, 13, 15                         |

## Concerns

1. **Perf budget is tight.** `restoration.mjs` has 4 lines of headroom (295
   of 299) and `rules.mjs` has 10. Any extra comment during execution can flip
   the file-length identity. Task 14 measures it.
2. **Behaviour-preserving refactors of existing code** (Task 3, and the loop
   merge in Task 7) exist only to fit the ratchet. They are pinned by the
   existing restoration suite and planted positives, but a reviewer should read
   them as refactors, not features.
3. **Resolved at APPROVE_PLAN:** `wpSetUpBeforeClass` is not an SV002 setup
   marker (WP's base `tear_down_after_class` deletes its factory data). Add a
   negative test: `wpSetUpBeforeClass` alone stays silent.
4. **`--confirm` framework fallback.** A `.php` target in a repo with a
   `vitest.config.*` in cwd resolves to vitest, not `null`. Documented, not
   fixed (out of scope).
5. **SV004 now also fires on JS `function testFirst(` / Python
   `def testFirst(`.** Zero current hits in canary. It is a small scope widening
   beyond PHP, and is intentional.
6. **The spec mentions a `provenance.json` that is not present** in
   `docs/changes/1106-savant-php/`. The assumptions live in this plan instead.
