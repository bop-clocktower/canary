# #906: reduce `createParser` complexity (guarded refactor)

`createParser` in `agents/skills/lib/parse-args.mjs` is the shared argument
parser behind every bundled skill's `cli:` entry. That makes its behavior a
public API. harness `check-perf` reported it at cyclomatic complexity 42 (error
threshold 15), nesting depth 6 and 155 lines, plus a nested `if` at 13. The
human classified this change as RISKY and overrode it to a **guarded** refactor,
which fixes the order: pin, prove the pins bite, refactor, converge.

## Consumers (10 skill CLIs + 2 suites)

| Consumer                                           | Spec features used                                      |
| -------------------------------------------------- | ------------------------------------------------------- |
| `claude-code/canary-blackhawk/scripts/cli.mjs`     | booleans, defaults, positionals                         |
| `claude-code/canary-cassandra/scripts/cli.mjs`     | booleans, defaults, positionals                         |
| `claude-code/canary-fail-fast/scripts/cli.mjs`     | values                                                  |
| `claude-code/canary-instrument/scripts/cli.mjs`    | values, defaults, required (2 flags)                    |
| `claude-code/canary-katana/scripts/cli.mjs`        | booleans, values, defaults (`repo: '.'`)                |
| `claude-code/canary-savant/scripts/cli.mjs`        | booleans, values, int (`--seed`), defaults, positionals |
| `claude-code/canary-screech/scripts/cli.mjs`       | booleans, values, defaults, required                    |
| `claude-code/canary-shadow/scripts/cli.mjs`        | values, booleans, required (`--cases`)                  |
| `claude-code/canary-strix/scripts/cli.mjs`         | booleans, values                                        |
| `claude-code/canary-test-reporter/scripts/cli.mjs` | values, required (`--results`)                          |
| `test/parse-args.test.ts`                          | unit contract (extended here)                           |
| `test/skill-cli-conformance.test.ts` (#663 / #479) | discovery-driven, one row per `cli:` skill              |

No consumer declares a single-dash flag other than the built-in `-h`, and none
relies on behavior the tests did not already state.

## Branch pin table

A new block, `createParser -- public-API pin table (#906)`, asserts the
**whole** result object (`opts`, `positionals`, `help`, `error`) and a
null-prototype `opts` for every row. Error text is compared exactly.

| Branch                            | Pinned by                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `argv` omitted → `[]`             | "no argv at all uses [] and applies defaults"                                                          |
| `--flag value` / `--flag=value`   | two rows, plus an inline value that looks like a flag                                                  |
| short flags (declared `-o`, `-v`) | value and boolean rows; `-o=x` is never split                                                          |
| boolean given `=value`            | `unrecognized arguments: --json=1`                                                                     |
| repeated flags                    | last value wins; a repeated boolean stays true                                                         |
| unknown flags                     | long, short, `--=x`; the first failure stops the scan                                                  |
| `--` terminator                   | help and `--` after it are positionals; unrecognized without positionals                               |
| lone `-`                          | positional with positionals declared, unrecognized without                                             |
| help                              | earlier options are kept; beats missing-required; exact result                                         |
| arity                             | end-of-argv (long and short), `''`, `--seed=`, a dash token for string/int flags                       |
| int parsing                       | separate negative token, leading zeros, `1.5`, `' 5'`, safe max, `-2^53`                               |
| defaults                          | boolean and int keys; a default satisfies a required flag                                              |
| required                          | only the missing flags are reported, before positional defaults apply                                  |
| positional defaults               | applied only when none are found, never when undeclared                                                |
| per-call isolation                | fresh opts/positionals on each call                                                                    |
| construction errors               | exact text for `spec.prog is required`, `defaults names unknown key`, `required names undeclared flag` |

Result: `parse-args.test.ts` goes from 41 to 83 tests.

## Mutation matrix (run against the pre-refactor file, then reverted)

Each mutation was applied on its own and only `test/parse-args.test.ts` was run.
The file was restored from memory in a `finally` block, and `git status`
confirmed it clean afterwards.

| #   | Mutation                               | Result      |
| --- | -------------------------------------- | ----------- |
| M01 | `prog` required check removed          | CAUGHT (1)  |
| M02 | null-prototype map → plain object      | CAUGHT (4)  |
| M03 | defaults unknown-key check removed     | CAUGHT (2)  |
| M04 | required undeclared-flag check removed | CAUGHT (2)  |
| M05 | `argv = []` default dropped            | CAUGHT (1)  |
| M06 | booleans not defaulted to false        | CAUGHT (36) |
| M07 | value default `null` → `undefined`     | CAUGHT (37) |
| M08 | defaults not assigned                  | CAUGHT (1)  |
| M09 | tokens after `--` dropped              | CAUGHT (2)  |
| M10 | help short-circuit removed             | CAUGHT (4)  |
| M11 | `--` accepted without positionals      | CAUGHT (2)  |
| M12 | `--` not a terminator                  | CAUGHT (2)  |
| M13 | `=` split also for single-dash flags   | CAUGHT (1)  |
| M14 | boolean accepts an inline value        | CAUGHT (1)  |
| M15 | int dash-value exemption removed       | CAUGHT (3)  |
| M16 | dash-value exemption for every type    | CAUGHT (1)  |
| M17 | next flag consumed as a value          | CAUGHT (3)  |
| M18 | value token not skipped                | CAUGHT (7)  |
| M19 | empty value accepted                   | CAUGHT (4)  |
| M20 | int syntax check removed               | CAUGHT (6)  |
| M21 | safe-range check removed               | CAUGHT (2)  |
| M22 | int stored as a string                 | CAUGHT (7)  |
| M23 | lone `-` not a positional              | CAUGHT (2)  |
| M24 | every dash token is a positional       | CAUGHT (10) |
| M25 | required check removed                 | CAUGHT (2)  |
| M26 | required message join changed          | CAUGHT (1)  |
| M27 | positional defaults always applied     | CAUGHT (7)  |
| M28 | `unrecognized arguments` text changed  | CAUGHT (21) |
| M29 | `invalid int value` quoting changed    | CAUGHT (6)  |

**29 of 29 caught.**

## Refactor

Everything stays in the same file, split into one helper per decision. The
`fail` closure is gone, and `parse` is a one-line delegate to `parseArgv`. Each
helper returns an outcome (`{consumed}`, `{help}` or `{error}`), which replaces
the early-return ladder.

## Complexity per function (TypeScript compiler API; nested functions measured separately)

| Before                     | cc  | nesting | lines |
| -------------------------- | --- | ------- | ----- |
| `createParser`             | 7   | 2       | 155   |
| `parse` (closure)          | 33  | 4       | 122   |
| `fail` (closure)           | 1   | 0       | 4     |
| `required.filter` callback | 2   | 0       | 4     |

harness's brace-span view folds the closures into `createParser`, which is where
its 42 comes from.

| After                   | cc     | nesting | lines |
| ----------------------- | ------ | ------- | ----- |
| `expectedOneArgument`   | 1      | 0       | 3     |
| `assertSpecSatisfiable` | 5      | 2       | 17    |
| `initialOpts`           | 4      | 1       | 9     |
| `splitInlineValue`      | 3      | 1       | 5     |
| `cannotBeValue`         | 4      | 1       | 4     |
| `readRawValue`          | 3      | 1       | 5     |
| `parseIntValue`         | 3      | 1       | 16    |
| `coerceValue`           | 3      | 1       | 8     |
| `takeValue`             | 3      | 1       | 9     |
| `isPositional`          | 3      | 1       | 4     |
| `readOptionToken`       | 5      | 1       | 15    |
| `endOptions`            | 2      | 1       | 5     |
| `readToken`             | 5      | 1       | 13    |
| `scanTokens`            | 3      | 2       | 8     |
| `missingRequired` (+cb) | 1 (+2) | 0       | 6     |
| `parseArgv`             | 6      | 1       | 21    |
| `createParser`          | 3      | 1       | 27    |
| `parse` (delegate)      | 1      | 0       | 3     |

Every function now sits at complexity ≤ 6 and nesting ≤ 2.

## Convergence (harness CLI 12.7.0, the version CI resolves for `@12`)

| Gate                                    | Before                                            | After                                                           |
| --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `harness check-perf`: total             | 224                                               | 220                                                             |
| `check-perf`: `parse-args.mjs` findings | 4 (cc 42 error, nesting 6, 155 lines, `if` cc 13) | 0                                                               |
| `perf-ratchet.mjs --base-report`        | OK 224 / 233                                      | delta OK: 0 new against the base; OK 220 / 233                  |
| `entropy-ratchet.mjs --base-report`     | OK 144 / 145                                      | delta OK +0; OK 144 / 145                                       |
| `harness check-arch --json`             | 14 pre-existing, 0 new, 0 regressions             | 14 pre-existing, 0 new, 0 regressions                           |
| arch `module-size`                      | no regression                                     | no regression; `agents/skills` is outside its scope (see below) |

The module-size scope was checked with a planted positive rather than assumed.
Appending 3000 exported lines to `parse-args.mjs` produced no module-size
regression, while the same 3000 lines in a new `ts/src/util` file did. So
`agents/skills` does not count toward the `module-size` total, and this file's
growth (214 → 275 lines, mostly relocated why-comments) cannot trip it.

No ceiling, floor, baseline or allowance was changed.
