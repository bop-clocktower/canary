# canary-blackhawk: PHP support (core PHP + WordPress idioms)

**Keywords:** blackhawk, temporal-dependency, php, wordpress, phpunit,
frozen-clock, suppression, suffix-gating

Issue: #1107. Route: feature (brainstorming then autopilot, autonomous fleet
lane; every design question below was answered with its recommended default and
is recorded as an assumption in `provenance.json`).

## Overview

`canary-blackhawk` reads only `.py`/JS/TS sources
(`agents/skills/claude-code/canary-blackhawk/scripts/scanner.mjs:14`), so a PHP
test suite scans zero files. This change makes `.php` a supported suffix and
gives each of the four rules (BH001-BH004) a PHP token set, plus the PHP
frozen-clock idioms that suppress the clock-dependent rules.

Out of scope:

- The issue's second ask (surface the abstention without `--strict`) already
  shipped: `scripts/cli.mjs` prints
  `Abstained - verified zero items; this is not a pass.` in the default text
  summary, pinned by `agents/skills/test/canary-blackhawk.test.ts` ("zero
  scanned files ABSTAINS, never a clean bill of health").
- canary-savant PHP support (#1106, a sibling lane). No code is shared with it;
  `string-literals.mjs` (byte-identical with savant's copy) is not modified.
- Laravel/Symfony framework helpers beyond the listed suppression markers.

## Decisions made

| #   | Question                                                         | Decision (recommended default)                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Widen the shared patterns, or gate PHP tokens by file language?  | **Gate by language.** Each rule gains a `php` variant (`pattern` + `keep`); a `.php` file is matched only against PHP variants, every other file only against the existing patterns. `date(2024, 1, 1)` is a legitimate Python constructor, so a shared `date(` token would false-positive on Python.    |
| D2  | `new DateTimeZone('UTC')` is the canonical fix. Flag it?         | **No.** BH003 fires on `new DateTimeZone(...)` unless its argument is a UTC literal (`'UTC'`, `'GMT'`, `'Etc/UTC'`, `'Z'`, `'+00:00'`), and on `date_default_timezone_get()` (the host zone).                                                                                                            |
| D3  | Which rules do the WP `pre_option_*` filters suppress?           | **As the issue groups them: frozen-clock markers.** They suppress BH001/BH002/BH004 file-wide. BH003 stays never-suppressed, preserving the documented invariant.                                                                                                                                        |
| D4  | Trailing `//` / `#` comments on a PHP code line?                 | **Rejected locally.** A match starting at or after the first `//` or `#` (not `#[`) outside a string literal is dropped, PHP files only (JS `#private` fields make `#` unsafe elsewhere). Implemented in `scanner.mjs`; `string-literals.mjs` is untouched.                                              |
| D5  | `checkdate()` is a pure validator.                               | Flagged only when it is fed from the clock, which the inner `date()`/`time()` read already catches (`checkdate(2, 29, (int) date('Y'))` fires; `checkdate(2, 29, 2024)` does not).                                                                                                                       |
| D6  | `*_IN_SECONDS` constants?                                        | BH004 fires when `DAY`/`WEEK`/`MONTH`/`YEAR_IN_SECONDS` is used in `+`/`-` timestamp arithmetic: fixed-length calendar units drift across DST and leap days. A bare `HOUR_IN_SECONDS` cache TTL is not flagged.                                                                                          |
| D7  | PHP test-file naming?                                            | PHPUnit `*Test.php` and WordPress `test-*.php`, plus the existing test directories (`tests/`, `test/`, ...).                                                                                                                                                                                             |
| D8  | `gmdate` vs `date`?                                              | `date(fmt)` fires BH001 and BH003; `date(fmt, $ts)` fires BH003 only; `gmdate(fmt)` fires BH001 only; `gmdate(fmt, $ts)` fires nothing - the issue's `gmdate()` -> `date()` swap becomes a BH003 finding.                                                                                                |
| D9  | Carbon `setTestNow` is a suppression marker. What does it cover? | Adds `Carbon::now()` / `Carbon::today()` (and `CarbonImmutable`) as BH001 tokens so the marker has something to suppress; also adds the procedural aliases `date_create()` and WP `current_datetime()`. Symfony's `@group time-sensitive` (which activates ClockMock) is a marker alongside `ClockMock`. |

### Approaches considered

1. **Per-rule `php` variant, selected by suffix (chosen).** Rule ids, severities
   and `why` stay single-sourced; `--help` stays generated from `RULES`.
   Complexity low; risk: a second pattern per rule to maintain.
2. **Separate PHP rule objects with a `languages` field.** Duplicates rule ids
   in `RULES`, so `--help` and every test that iterates `RULES` would see each
   rule twice. Rejected.
3. **Widen the shared regexes.** Smallest diff, but PHP-only tokens (`date(`,
   `time()`, `sleep(`) would fire on Python and JS. Rejected (D1).

## Technical design

`rules.mjs`

- `FROZEN_CLOCK_MARKERS` += `ClockMock`, `time-sensitive`, `PHPMock`,
  `getFunctionMock`, `php-mock`, `setTestNow`, `pre_option_gmt_offset`,
  `pre_option_timezone_string`.
- Each rule gets `php: { pattern, keep }`. PHP patterns are case-insensitive
  (PHP function and class names are) and require the call token not to be a
  method/property/variable (`(?<![\w$>:])`), so `$obj->time()`, `Foo::date()`
  and `$date(` never fire.
  - BH001: `time()`, `date(fmt)`/`gmdate(fmt)` with one argument, `mktime()`
    with none, `strtotime('now'|'+1 day'|'tomorrow'|...)`, `microtime(`,
    `hrtime(`, `new DateTime`/`DateTimeImmutable` with no argument or `'now'`,
    `date_create()`, `Carbon::now()`/`today()`, WP `current_time(`,
    `current_datetime(`, `wp_date(fmt)`, `date_i18n(fmt)`.
  - BH002: `sleep(n)`, `usleep(n)`, `time_nanosleep(s, ns)` with a positive
    literal.
  - BH003: `date(` (any arity), `mktime(` with arguments, `strftime(`,
    `IntlDateFormatter`, `setlocale(`, `date_default_timezone_set(`,
    `date_default_timezone_get(`, non-UTC `new DateTimeZone(`.
  - BH004: a comparison against `new DateTime('YYYY...')` / `strtotime(...)`
    with no timezone token on the line, or `DAY|WEEK|MONTH|YEAR_IN_SECONDS` in
    `+`/`-` arithmetic.
- `delayIsPositive` treats any positive `delay*` group as positive
  (`time_nanosleep(0, 500)` is a real delay).

`scanner.mjs`

- `SUPPORTED_SUFFIXES` += `.php`; `isTestFile` accepts `*Test.php` and
  `test-*.php`.
- `scanTextFull` picks the variant by the file's suffix and, for PHP, drops
  matches inside a trailing comment (D4).

## Integration Points

### Entry Points

None new. The existing `canary-blackhawk` CLI (`scripts/cli.mjs`) gains a
language; its flags, JSON shape and exit codes are unchanged.

### Registrations Required

None. No new module, script or test file (the tests extend
`agents/skills/test/canary-blackhawk.test.ts`), so the entropy `entryPoints`
arrays are untouched.

### Documentation Updates

`agents/skills/claude-code/canary-blackhawk/SKILL.md`: the rules table, the
suppression marker list, the test-file naming and the supported-suffix list.

### Architectural Decisions

None (small change inside one self-contained skill).

### Knowledge Impact

None beyond the SKILL.md rubric.

## Success Criteria

1. When a directory holds `tests/ClockTest.php`, blackhawk shall scan it
   (`files_scanned` >= 1).
2. For each of BH001-BH004 a PHP positive fires and a PHP negative does not.
3. If a PHP file contains a frozen-clock marker (`ClockMock`, `PHPMock`,
   `setTestNow`, `pre_option_gmt_offset`, ...), then BH001/BH002/BH004 shall not
   fire in it; BH003 still does.
4. If a PHP token appears only inside a string literal, a full-line comment or a
   trailing comment, then blackhawk shall not fire.
5. PHP-only tokens (`date(2024, 1, 1)`, `sleep(1)`) shall not fire on a
   `.py`/`.ts` file.
6. `gmdate('Y-m-d', $ts)` fires nothing; `date('Y-m-d', $ts)` fires BH003.

## Implementation Order

1. Tests first (red): PHP positives/negatives per rule, suppression, comment and
   string rejection, language gating, path selection.
2. `rules.mjs` PHP variants and markers; `scanner.mjs` suffix, test-file naming,
   variant selection, trailing-comment rejection.
3. SKILL.md docs; planted-positive check; gates.
