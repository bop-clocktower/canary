# canary-savant: PHP support (#1106)

**Keywords:** canary-savant, php, phpunit, wordpress, superglobals,
shared-state, order-dependence, abstention

## Overview

`canary-savant` cannot read PHP. `SUPPORTED_SUFFIXES`
(`agents/skills/claude-code/canary-savant/scripts/scanner.mjs:36`) leaves out
`.php`, so a run against a PHPUnit or WordPress suite scans zero files. This
change adds PHP to the static pass (SV001–SV004). The token sets cover core PHP
and the WordPress test idioms.

**The issue's second ask has already shipped.** An abstention is visible without
`--strict`. `scripts/cli.mjs:42-98` prints
`⚠ Abstained — verified zero items; this is not a pass.` in the default summary
when zero files were scanned, and `agents/skills/test/gate-conformance.test.ts`
(row `canary-savant (zero scanned files)`) already pins both the advisory run
(loud, exit 0) and the `--strict` run (exit 3). This change does not rebuild it.

**Out of scope:**

- The `--confirm` dynamic pass for PHP. PHPUnit has `--order-by=random`, but a
  runner port is a separate feature. A `.php` target keeps declining loudly
  (`runner.mjs` `detectFramework` returns `null`).
- canary-blackhawk PHP support (#1107, a sibling lane).
- Sharing a PHP-aware stripper across skills (#479).

## Decisions made

This brainstorm ran as an autonomous fleet lane. The human answered the scope
fork (Core PHP + WordPress idioms). The remaining choices are the recommended
defaults, and `provenance.json` records them as assumptions.

| #   | Decision                     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope                        | Core PHP plus WordPress idioms                                                                                                                                                                                                                                                                                                                                                                                                                 | Human answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D2  | Where it lives               | **A (chosen):** extend `scanner.mjs`, `rules.mjs` and `restoration.mjs` in place with an `isPhp` branch beside `isPy`, and data-driven singleton families. **B (rejected):** a new `php.mjs` module.                                                                                                                                                                                                                                           | A is the shape the issue names (`scanner.mjs:240`). B adds a new module, which trips the entropy `entryPoints` ratchet and duplicates the scan plumbing. A keeps each rule in one place.                                                                                                                                                                                                                                                                                                                                    |
| D3  | Comment and string handling  | Reuse `string-literals.mjs` and the existing comment projection **unchanged**                                                                                                                                                                                                                                                                                                                                                                  | PHP `'…'`/`"…"` strings and `//`, `#`, `/* */`, `*` comments are already recognised. `string-literals.mjs` is pinned byte-identical to blackhawk's copy, so it must not fork. No PHP-specific stripper is needed.                                                                                                                                                                                                                                                                                                           |
| D4  | SV001 PHP shapes             | Fires on the declaration of: a column-0 `$x = []` / `array()`, a `static $x` (local or class property, typed or not), and a `global $x` import. It fires only when the file mutates that variable **in place**: `$x[] =`, `$x['k'] =`, compound assignment (`.=`, `+=`, `??=` …), `++`/`--`, `array_push/unshift/splice/pop/shift($x`, or `$x->prop =`.                                                                                        | These are the leak shapes the issue names. A plain `$x = …` reassignment does not count, because it is also how a restore is written. A missed suspect costs less than a false one (SKILL.md).                                                                                                                                                                                                                                                                                                                              |
| D5  | `$GLOBALS[...]` writes       | SV003 only, not SV001                                                                                                                                                                                                                                                                                                                                                                                                                          | A `$GLOBALS` write has no declaration line for SV001 to anchor on. As a singleton mutation it also gets restore analysis for free. Reporting the same line under both rules would count one smell twice.                                                                                                                                                                                                                                                                                                                    |
| D6  | SV002 PHP pairs              | Class-scoped only: `setUpBeforeClass`/`tearDownAfterClass` (PHPUnit), plus `set_up_before_class`/`tear_down_after_class` (WP_UnitTestCase). Per-test `setUp`/`set_up` and `wpSetUpBeforeClass` are **excluded**.                                                                                                                                                                                                                               | This matches the documented SV002 policy (`rules.mjs` comment and SKILL.md). A per-test setup rebuilds its state for every test, so a missing teardown does not leak. Firing on it was the dominant false positive in Phase 5 dogfooding. The issue asks for SV002 to be "the same". Per-test leaks in PHP (superglobals, hooks, options) are SV003's job, and SV003 is where they get caught. `wpSetUpBeforeClass` builds factory data that WP's base `tear_down_after_class` deletes, so it never needs its own teardown. |
| D7  | SV003 PHP families           | Superglobals `$_GET $_POST $_COOKIE $_SERVER $_ENV $_SESSION $_REQUEST $_FILES $GLOBALS` (keyed element write, `[]=`, or whole reassign), plus `putenv`, `ini_set`, `date_default_timezone_set`, `define` (**unrestorable**: never suppressed), WP hooks `add_filter`/`add_action`, and WP options `update_option`/`add_option`.                                                                                                               | This is the token set from the answered fork. `define()` cannot be undone in PHP, so a restore can never launder it.                                                                                                                                                                                                                                                                                                                                                                                                        |
| D8  | SV003 PHP restore evidence   | These count as restores: the same key written or unset inside a `tearDown*`/`tear_down*`/`wpTearDown*` method body or a `finally {}` block, a whole-family reassign there, `ini_restore`, `delete_option`, and `putenv('K')` (unset). Hooks are paired **anywhere in the file**: a `remove_filter`/`remove_action`/`remove_all_*` for the same hook. A snapshot write-back (`$_SERVER = $saved` after `$saved = $_SERVER`) is also recognised. | This follows the existing positive-evidence rule (`restoration.mjs` header). Hooks pair file-wide because the WordPress idiom is an inline `add_filter` … `remove_filter` inside the test body.                                                                                                                                                                                                                                                                                                                             |
| D9  | WP_UnitTestCase auto-restore | In a file whose class `extends` a `WP_*UnitTestCase*` base, hook and option mutations count as restored                                                                                                                                                                                                                                                                                                                                        | `WP_UnitTestCase_Base` backs up and restores `$wp_filter` around every test (`_backup_hooks`/`_restore_hooks`). It also wraps every test in a DB transaction that is rolled back, which undoes option writes. Flagging these would be false positives on the framework's own guarantee. Superglobals are not covered here, which is the conservative choice.                                                                                                                                                                |
| D10 | SV004                        | Same text patterns. The code-anchored name pattern also accepts `function` (PHP) alongside `def`, and a camelCase terminal ordinal (`testFirst()`)                                                                                                                                                                                                                                                                                             | Keeps "same as today" semantics. A PHP ordinal test name is the same smell as a Python one.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D11 | Test-file discovery          | `.php` files named `*Test.php` (PHPUnit) or `test-*.php` (WordPress), plus any `.php` file under the existing test dirs. Adds `vendor` to the skipped directories.                                                                                                                                                                                                                                                                             | These are the conventions of the two ecosystems in scope. `vendor/` is Composer's `node_modules`.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Technical design

- **`rules.mjs`**
  - `SINGLETON_FAMILIES` gains PHP entries built from one table. Each family can
    now carry three optional fields: `keyOf(match)` for a non-bracket key (the
    `putenv` `NAME=` form), `unrestorable: true` (for `define`), and
    `pairAnywhere: true` (for WP hooks).
  - New exports: `PHP_SETUP_TEARDOWN`, `PHP_MODULE_MUTABLE`, `PHP_STATIC_DECL`,
    `PHP_GLOBAL_DECL`, `phpMutationPattern(name)`, and `WP_TESTCASE_BASE`.
  - `SV004_CODE_PATTERN` gains the `function` and camelCase alternatives.
- **`scanner.mjs`**
  - `.php` is added to `SUPPORTED_SUFFIXES`.
  - `isTestFile` learns the PHP naming conventions. `vendor` joins `SKIP_DIRS`.
  - `sv001` dispatches to a PHP declaration pass when `isPhp`.
  - `sv002` picks `PHP_SETUP_TEARDOWN` and matches `function <setup>(` when
    `isPhp`.
- **`restoration.mjs`**
  - `keyOf` honours a family's `keyOf`.
  - A new `collectPhpRegions` scans `tearDown*`/`tear_down*`/`wpTearDown*`
    method bodies. It counts braces with string awareness from the method token,
    so an Allman `{` on the next line works, and it is capped at 50 lines like
    the JS collector. The existing brace-balanced `finally {` collector already
    covers PHP.
  - `restores()` refuses `unrestorable` families. `pairAnywhere` families accept
    a delete anywhere in the file. A WP_UnitTestCase file restores the hook and
    option families.
- **`SKILL.md`**
  - Update the description ("pytest and vitest idioms" becomes "pytest, vitest
    and PHPUnit/WordPress idioms"), the rules table, framework conditioning, the
    fidelity limits (heredoc/nowdoc, multi-line calls, no `--confirm` for PHP)
    and the documented suffix list.

## Integration Points

### Entry Points

None new. The existing `canary skills run canary-savant` CLI now accepts `.php`
paths.

### Registrations Required

None. No new module, so the entropy `entryPoints` arrays are unchanged.

### Documentation Updates

- `agents/skills/claude-code/canary-savant/SKILL.md`: description, rules table,
  framework conditioning, fidelity limits, supported suffixes.
- `CHANGELOG.md`: an Unreleased entry.

### Architectural Decisions

None. This is a small, additive rule-table extension inside one skill.

### Knowledge Impact

None beyond SKILL.md. The PHP idiom catalogue lives in `rules.mjs`, next to the
existing Python and JS catalogues.

## Success Criteria

1. When a directory holds a `FooTest.php` or `test-foo.php` file, savant shall
   scan it (`files_scanned >= 1`).
2. Each PHP rule shape in D4 and D7 shall have a positive fixture that fires and
   a negative fixture that stays silent. The negatives are the restore/pair/read
   shapes, for example a superglobal write restored in `tearDown`.
3. If a PHP token appears only in a comment or string literal, then savant shall
   not report it.
4. `define()` shall fire even when a teardown mentions the same constant.
5. In a WP_UnitTestCase file, an `add_filter` shall not fire, and a `$_GET`
   write without a restore still shall.
6. Existing Python and JS behaviour is unchanged. The full savant suite is
   green, and the string-literals parity test is green.
7. At least one planted positive per new code path turns a new test red, and
   restoring the code turns it green again.

## Implementation Order

1. Test-file discovery and suffix (tests first).
2. SV003 PHP families and restoration, including WP.
3. SV001 PHP declarations.
4. SV002 PHP pairs and SV004 name pattern.
5. SKILL.md and CHANGELOG, then the four gates.
