# Engine-Linter Parity: Exclusions, Strict Mode, and Inline Suppression

**Status:** Approved — brainstormed 2026-08-03. Three structural decisions made
interactively (scope, gate location, residual-finding handling). Unblocks the
`--strict` ratchet for Job A of `.github/workflows/dogfood.yml`.

**Keywords:** review-test, flake-check, exclude, strict, pragma, suppression,
skip-dirs, fixtures, dogfood, ratchet, denominator, abstention

## Overview

Canary ships two linter families that answer the same question in two runtimes:

|                      | Runtime      | Skip-dirs | Fixture skip | Inline pragma | `--strict` |
| -------------------- | ------------ | --------- | ------------ | ------------- | ---------- |
| `canary-blackhawk`   | `.mjs` skill | yes       | yes (#493)   | yes (#393)    | yes        |
| `canary-savant`      | `.mjs` skill | yes       | yes          | yes (#498)    | yes        |
| `canary review-test` | TS engine    | **no**    | **no**       | **no**        | **no**     |
| `canary flake-check` | TS engine    | **no**    | **no**       | **no**        | **no**     |

The skills layer hardened in place over #393 → #485 → #493 → #498 → #499 while
the engine was being rewritten from Python to TypeScript. Every convention
flowed _sideways_ between the two skills and never _down_ into the engine. This
spec closes that gap.

The forcing function is the dogfood workflow. Job A runs `review-test` and
`flake-check` over three of canary's own suites and reports 19 findings, held
advisory pending triage. Triage says none of them is a defect:

- **13 are fixture data.** They sit in fixture directories that blackhawk has
  skipped by default since #493, under a rationale already written into
  `scanner.mjs:35-41`: _files here never RUN as tests, so a smell in one is a
  property of the data, not a defect._ These were never a backlog — the engine
  is missing a default the skills layer settled months ago.
- **6 are deliberate test pins.** Five in `ts/test/static-linter.test.ts` and
  one in `ts/test/pattern-healer.test.ts:122` are selector-rule tests that must
  contain `page.locator('.btn')` to assert LINT-001/002/003 fire at all. The
  linter flagging its own fixtures for the pattern they exist to prove is
  correct behavior with no way to say so.

(Counts verified against CI run 30795412308, not from memory.)

A false-green trap sits underneath: all six residual findings are `warning`
severity, and `reviewTestCmd` exits 0 unless a finding is `critical`. Flipping
the workflow to a strict gate by exit code alone would go green while holding
findings — the exact shape #508 spent five waves removing. The gate has to be a
real product flag, not a shell inference.

## Goals

1. **The engine linters skip what the skill linters skip**, by default, for the
   same written reason.
2. **`--exclude <glob>`** on `review-test` and `flake-check`, so a consumer can
   scope a run the way `guardian pr-check` already allows via `excludeGlobs`.
3. **`--strict`** on both, so "any finding fails" is expressible in the product
   and testable, rather than reconstructed from `--json` in workflow YAML.
4. **`canary-ignore <RULE> -- reason`** inline pragma, so a deliberate pin can
   declare itself with a reason instead of being excluded wholesale.
5. **Dogfood Job A ratchets to `--strict`** across all three directories, and
   the shell finding-counting loop is deleted.
6. **No default behavior changes.** Every new gate is opt-in; existing exit
   contracts are untouched.

## Non-goals

- **Not unifying the `.mjs` scanners with the TS engine.** They are separate
  runtimes with separate distribution; collapsing them is #479's scope. The
  duplication is knowingly accepted here.
- **No suppression/baseline file.** Pragmas live next to the code they excuse. A
  central ignore list is what makes suppressions un-auditable.
- **No new rules, no rule-precision changes.** #535/#537/#539 covered that.
- **No changes to `review-test`'s or `flake-check`'s default exit codes.**

## Architecture

Three new modules under `ts/src/core/`. None of them belongs in
`cli-commands.ts`, which is already 983 lines — file discovery, glob matching,
and suppression parsing are not command-dispatch concerns, and putting them
there is how that file got to 983 lines in the first place.

```text
ts/src/core/glob.ts                         [NEW]
  globMatches(path, pattern)       lifted verbatim from guardian/pr-check.ts

ts/src/core/test-file-discovery.ts          [NEW]
  SKIP_DIRS                        pattern-matcher's IGNORED_DIRS ∪ blackhawk's fixture dirs
  walkTestFiles(root, { exclude }) -> sorted string[]

ts/src/core/suppression.ts                  [NEW]
  stringLiteralRanges(line)        range-based port from the .mjs scanners
  execOutsideStrings(re, line, ranges)
  parsePragmas(lines) -> Map<lineNumber, Set<ruleId>>
```

`globMatches` gets its own module rather than riding along in
`test-file-discovery.ts`: `guardian/pr-check.ts` is a consumer, and a guardian
file importing its glob matcher from a module named "test-file-discovery" is the
kind of misleading dependency that makes people write a fourth copy.

Wired into existing files:

| File                            | Change                                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| `ts/src/cli.ts`                 | `--exclude <glob>` (repeatable) and `--strict` on both commands            |
| `ts/src/cli-commands.ts`        | `collectTestFiles` delegates to `walkTestFiles`; local `walkFiles` deleted |
| `ts/src/core/static-linter.ts`  | findings filtered through `parsePragmas`; new `lintFull` returns both      |
| `ts/src/guardian/pr-check.ts`   | imports `globMatches` from `core/glob.js`; local copy deleted              |
| `.github/workflows/dogfood.yml` | Job A adds `--strict`; `--json` counting loop deleted                      |

### The `static-linter` surface stays back-compatible

`lint()` keeps its current signature and returns kept findings only. A new
`lintFull()` returns `{ findings, suppressed }`, and `lint()` becomes a wrapper
over it. This is exactly the `scanText` / `scanTextFull` split blackhawk uses
(`scanner.mjs:169-172`) and it means no existing caller has to change to get
pragma support — they get it silently, which is the correct default, while the
callers that want to _report_ suppressions opt into the fuller shape.

Both rule families are covered: `LINT-00N` and `FLAKE-00N` are scanned by the
same core, so the pragma works identically for `review-test` and `flake-check`.

### Why the pragma filter lives in the linter, not the CLI

Suppression is a property of linting a file, not of one entry point. Putting the
filter in `static-linter.ts` means every caller inherits it — including
`guardian pr-check`, which lints changed files through the same core. Putting it
in the command would give two callers two different answers for the same file.

## Data flow

```text
canary review-test ts/test --exclude '**/legacy/**' --strict
      |
      v
walkTestFiles(root, exclude)
      |-- prune directory when SKIP_DIRS.has(name)     <- removes the 13 fixture findings
      |-- keep *.spec.ts *.test.ts *.spec.js *.test.js test_*.py
      +-- drop path when globMatches(path, anyExcludeGlob)
      |
      +--> files.length === 0 ------> abstainOnZeroFiles -> EXIT 3
      |
      v
static-linter: lint(file)
      |-- scan rules -> raw findings
      |-- parsePragmas(lines)   matched OUTSIDE string literals (#499)
      +-- move finding to `suppressed` when pragma on its line names its rule
      |
      v
report: "N finding(s), M suppressed"           M is always printed, never hidden
      |
      |-- default:  review-test exits 1 only on critical; flake-check exits 1 on any
      +-- --strict: exits 1 on ANY finding
```

### The `SKIP_DIRS` set

Union of the two existing sets, which is the point — neither linter family
should have a directory the other descends into.

From `ts/src/core/pattern-matcher.ts` (build/vendor noise): `node_modules`,
`.git`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `.next`, `.nuxt`

From `agents/skills/claude-code/canary-blackhawk/scripts/scanner.mjs` (caches
and test data): `.mypy_cache`, `.pytest_cache`, `.tox`, `fixtures`,
`__fixtures__`, `__mocks__`, `testdata`

`node_modules` is the one that is a live bug rather than a missing default:
`collectTestFiles` currently recurses into it, so `canary review-test .` in any
installed project lints every dependency's test suite. `pattern-matcher.ts` has
guarded against this since it was written and is test-pinned at
`ts/test/pattern-matcher.test.ts:35`; `cli-commands.ts` simply never got the
same walker.

## Interface decisions

### `--exclude` is repeatable, not variadic

```js
.option('--exclude <glob>', 'exclude paths matching glob (repeatable)', collect, [])
```

Commander's variadic form (`<glob...>`) would swallow the positional path
argument: `canary review-test --exclude a b ts/test` would parse `ts/test` as a
third glob and then abstain on a missing path. Repeatable is unambiguous.

Globs are matched by `globMatches` as lifted from `guardian/pr-check.ts` —
supporting `**/`, `**`, `*`, and `?`. An unmatched glob is not an error; globs
are permissive by nature and erroring on a non-matching pattern would make
shared CI configs brittle.

### `--strict` and the abstention contract

| Situation                   | default           | `--strict` |
| --------------------------- | ----------------- | ---------- |
| zero files matched          | **3**             | **3**      |
| any finding — `review-test` | 0 unless critical | **1**      |
| any finding — `flake-check` | 1                 | **1**      |
| clean run                   | 0                 | 0          |

The first row is the load-bearing one. `--strict` must never convert an
abstention into a finding-failure, because the two mean opposite things: exit 1
says "I looked and found something", exit 3 says "I never looked". Collapsing
them is what ADR 0009/0010 exist to prevent.

This gives `--exclude` a property worth stating: **an exclusion broad enough to
match every file abstains rather than passing.** A typo'd glob that silently
zeroed the denominator would otherwise be the most inviting false-green in the
whole feature. `dogfood.yml` already treats exit 3 from this job as a
configuration break, so the workflow catches it with no extra logic.

### Pragma syntax and matching

```js
// canary-ignore LINT-001 -- selector rules assert on quoted selectors by design
expect(rules(lint('c.spec.ts', "page.locator('.btn').click();"))).toContain(
  'LINT-001',
);
```

Ported from `scanner.mjs:88-116` with the same three constraints:

- **Rule-scoped.** A pragma naming no rule is not a suppression. Blanket
  line-silencing is how suppression comments become invisible.
- **Reason required** (`-- <text>`). Keeps suppressions greppable and
  reviewable.
- **A pragma covers its own line and the next line**, matching the two idioms
  teams use: trailing comment, and comment above the code.
- **Matched outside string literals only** (#499). A `canary-ignore` inside a
  string is data, not a directive. This suite necessarily carries pragma text
  inside fixture strings, so the self-scan is precisely what is at risk.

**One deliberate divergence from blackhawk.** `scanner.mjs:119-120` matches a
token against `ruleId.split('-')[0]`, so `BH002` matches `BH002-real-delay`.
That prefix is still rule-specific for blackhawk's ids. Canary's ids are
`LINT-001`…`LINT-006` and `FLAKE-001`…`FLAKE-004`, where the prefix is a rule
_family_ — `canary-ignore LINT` would silence all six lint rules through the
back door. **Exact rule-id match only.**

### Suppressions are counted and reported

`lintFull()` returns suppressed findings alongside kept ones, and the CLI prints
`N finding(s), M suppressed`. A linter that hides what it silenced has the same
defect as a gate that hides what it did not check: you cannot audit a
denominator you cannot see. This mirrors `scanPaths`' `suppressed` return in
`scanner.mjs:247`.

## Error handling

| Condition                           | Behavior                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| Unreadable directory during walk    | Skipped silently (existing `try/catch` behavior, unchanged)                  |
| Exclude glob matches nothing        | Not an error; run proceeds                                                   |
| Exclude reduces file set to zero    | Abstain, exit 3 — never a pass                                               |
| Pragma with no reason               | Not a suppression; the finding stands                                        |
| Pragma naming no rule token         | Not a suppression; the finding stands                                        |
| Pragma naming an unknown rule id    | Parsed, never matches, no error (a stale-suppression report is out of scope) |
| Pragma text inside a string literal | Ignored — data, not directive (#499)                                         |

## Testing

Tests are written before implementation, per repo practice. Every row below is a
new or modified test.

**`ts/test/glob.test.ts`** (new)

- `**/`, `**`, `*`, and `?` behave as they did inside `guardian/pr-check.ts`
- a pattern matching nothing returns false rather than throwing

**`ts/test/test-file-discovery.test.ts`** (new)

- prunes `node_modules`, `.git`, `dist` — the live bug, pinned
- prunes `fixtures/`, `__fixtures__/`, `__mocks__/`, `testdata/`
- honors a single `--exclude` glob, and multiple globs
- returns paths sorted
- an exclude matching everything returns `[]` (feeding the abstention path)
- matches the same four test-file suffix patterns as before the refactor

**`ts/test/suppression.test.ts`** (new)

- pragma suppresses the named rule on its own line
- pragma suppresses on the following line
- pragma does **not** suppress a rule it did not name
- pragma without a reason does not suppress
- pragma naming no rule does not suppress
- `canary-ignore LINT` does not suppress `LINT-001` (the divergence, pinned)
- **pragma text inside a string literal does not suppress** (#499 regression)

**`ts/test/static-linter.test.ts`** (modified)

- suppressed findings are absent from `findings` and present in `suppressed`
- the existing selector-rule pins at `:52` and `:170` still pass unchanged

**`ts/test/cli-commands.test.ts`** (modified)

- `--strict` exits 1 when only `warning` findings exist (the false-green trap)
- default behavior unchanged: `review-test` exits 0 on warnings
- `--strict` with zero matched files exits **3**, not 1
- `--exclude` reduces the file set and is reflected in the reported denominator
- output includes the suppressed count

**`ts/test/guardian/pr-check.test.ts`** (modified)

- existing `excludeGlobs` behavior unchanged after `globMatches` is extracted

**CI (`dogfood.yml`)**

- Job A reports 0 findings at `--strict` for all three directories. This is the
  acceptance criterion for the whole change.

## Rollout

1. Land the two core modules with their tests (no behavior change yet).
2. Wire `collectTestFiles` to `walkTestFiles` — this alone drops the 13 fixture
   findings and fixes the `node_modules` descent.
3. Add `--exclude` and `--strict` to both commands.
4. Add pragmas with reasons to the six deliberate pins.
5. Flip Job A to `--strict` and delete the counting loop.

Steps 1–4 are individually shippable and non-breaking. Step 5 is the ratchet and
must go last, after Job A is observed at zero.

## Documentation

- `CHANGELOG.md` — `--exclude`, `--strict`, and the `canary-ignore` pragma under
  Added; the `node_modules` descent under Fixed.
- Command help text for both new flags.
- The pragma needs a documented home alongside blackhawk's, wherever
  `blackhawk-ignore` is described — a suppression syntax nobody can find is a
  suppression syntax nobody uses correctly.
