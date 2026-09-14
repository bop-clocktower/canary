# #907: guarded refactor of `pyEqual` (complexity 20)

Target: `pyEqual` in `ts/src/guardian/diff-extractor.ts`. This is a RISKY item
that was overridden to a GUARDED refactor. The guards ran in order: recover the
reference, pin, prove the pins bite, refactor, converge.

## 1. The Python reference

The deleted module is `agent/guardian/diff_extractor.py`, removed in `3f3cd877`
(`git show 3f3cd877^:agent/guardian/diff_extractor.py`). `pyEqual` stands in for
bare Python `==`/`!=` on `json.loads`/`yaml.safe_load` values:

- line 60: `(before.get("parameters") or []) != (after.get("parameters") or [])`
- line 62: `before.get("requestBody") != after.get("requestBody")`
- line 64: `before.get("security") != after.get("security")`
- line 72: `before_resp[code] != after_resp[code]`
- line 112: `op != before_op`

There were no dedicated parity fixtures for `pyEqual`. The only existing
coverage was the classifyChanges and extractApiDiff cases in
`ts/test/guardian-diff.test.ts`.

## 2. Rule table (pinned)

To get the expected values, I **evaluated `a == b` in real Python 3.14.6** for
every row, using `json.loads` for each side. MISSING means the key is absent, so
`.get` returns `None`. The pins go through the `requestBody` comparison (line
62), because `pyEqual` is not exported and exporting it would add a dead-export
identity.

| Row                                     | a                                      | b             | Python `==`  | Python rule                                     |
| --------------------------------------- | -------------------------------------- | ------------- | ------------ | ----------------------------------------------- |
| none-none                               | MISSING                                | MISSING       | True         | None == None                                    |
| none-null                               | MISSING                                | null          | True         | both None                                       |
| null-null                               | null                                   | null          | True         |                                                 |
| none-value                              | MISSING                                | {}            | False        | None never equals a value                       |
| value-none                              | {}                                     | MISSING       | False        |                                                 |
| null-false                              | null                                   | false         | False        | None is not falsy-equal                         |
| null-zero                               | null                                   | 0             | False        |                                                 |
| str-eq / str-ne                         | "a" / "a", "a" / "b"                   |               | True / False | str equality                                    |
| str-num                                 | "1"                                    | 1             | False        | no str/number coercion                          |
| int-float                               | 1                                      | 1.0           | True         | numeric tower                                   |
| int-int-ne                              | 1                                      | 2             | False        |                                                 |
| negzero                                 | 0                                      | -0.0          | True         |                                                 |
| bool-eq / bool-ne                       | true / true, true / false              |               | True / False |                                                 |
| nan-nan                                 | NaN                                    | NaN           | False        | IEEE NaN (distinct objects from separate loads) |
| list-eq                                 | [1,2]                                  | [1,2]         | True         |                                                 |
| list-order                              | [1,2]                                  | [2,1]         | False        | lists are order-dependent                       |
| list-len                                | [1]                                    | [1,1]         | False        |                                                 |
| list-empty                              | []                                     | []            | True         |                                                 |
| list-vs-dict / dict-vs-list             | [] / {}, {} / []                       |               | False        | no cross-container equality                     |
| list-vs-str                             | []                                     | ""            | False        |                                                 |
| list-nested / -ne                       | nested list/dict, equal / leaf differs |               | True / False | recursive                                       |
| list-null-elem                          | [null]                                 | [null]        | True         |                                                 |
| list-null-vs-false                      | [null]                                 | [false]       | False        |                                                 |
| dict-eq                                 | {a:1,b:2}                              | {a:1,b:2}     | True         |                                                 |
| dict-key-order                          | {a:1,b:2}                              | {b:2,a:1}     | True         | dicts are key-order independent                 |
| dict-extra-key                          | {a:1}                                  | {a:1,b:2}     | False        |                                                 |
| dict-diff-key                           | {a:1}                                  | {b:1}         | False        |                                                 |
| dict-diff-val                           | {a:1}                                  | {a:2}         | False        |                                                 |
| dict-null-vs-missing                    | {a:null}                               | {}            | False        | present-None is not the same as a missing key   |
| dict-null-vs-diffkey                    | {a:null}                               | {b:null}      | False        |                                                 |
| dict-nested-int-float                   | {a:{b:[1]}}                            | {a:{b:[1.0]}} | True         | numeric tower, nested                           |
| dict-vs-str / str-vs-dict / num-vs-list |                                        |               | False        | mixed types                                     |

**38 rows** match Python and are pinned to the Python value.

### Divergence found (parked as #922, not fixed here)

Python's `bool` is an `int` subclass, but the TS port treats bool and number as
unequal:

| Row            | a      | b   | Python | TS    |
| -------------- | ------ | --- | ------ | ----- |
| bool-int-true  | true   | 1   | True   | false |
| bool-int-false | false  | 0   | True   | false |
| bool-float     | true   | 1.0 | True   | false |
| list-bool-int  | [true] | [1] | True   | false |

These 4 rows are pinned at the **current TS** behavior
(`KNOWN_DIVERGENCE_ROWS`), and each one also asserts that Python's answer is
`True`, so the refactor is checked as behavior-preserving. Fixing the divergence
is #922.

## 3. Mutation matrix (run against the pre-refactor `pyEqual`, all reverted)

| Mutation                           | Result          |
| ---------------------------------- | --------------- |
| M1 identity shortcut returns false | RED (50 failed) |
| M2 a-is-None always returns true   | RED (4)         |
| M3 b-is-None returns true          | RED (1)         |
| M4 drop array length check         | RED (3)         |
| M5 drop both-arrays check          | RED (1)         |
| M6 drop element recursion          | RED (5)         |
| M7 array match returns false       | RED (47)        |
| M8 drop dict key-count check       | RED (1)         |
| M9 drop hasOwn key check           | RED (1)         |
| M10 drop dict value recursion      | RED (6)         |
| M11 dict match returns false       | RED (5)         |
| M12 fall-through returns true      | RED (18)        |

**12 of 12 caught.** The source was restored from memory after each run, and
`git status` was clean before the refactor.

## 4. Refactor

The refactor splits the function into `isNone`, `pyListEqual` and `pyDictEqual`,
all in the same file. `pyEqual` now only dispatches: identity, then None, then
list, then dict. It adds no new perf identity. The table passes unchanged.

Line count: the first split pushed the file to 308 lines, which tripped the
300-line file-size rule as a new identity. I compacted the helpers (a
single-statement `for`, `Object.hasOwn` in place of
`Object.prototype.hasOwnProperty.call`, which has identical semantics under
ES2022) and the file is now 295 lines. I did not rewrite any literals or add any
suppression.

## 5. Convergence (harness CLI 12.7.0, same as the baselines)

| Check                               | Before (origin/main)  | After                                         |
| ----------------------------------- | --------------------- | --------------------------------------------- |
| `harness check-perf`, `pyEqual`     | complexity 20 (error) | gone; no finding for any helper               |
| `perf-ratchet.mjs --base-report`    | 224                   | 223, 0 new findings (OK)                      |
| `entropy-ratchet.mjs --base-report` | 144                   | 144, +0 (OK)                                  |
| `harness check-arch`                | 14 issues             | 13 issues; only the `pyEqual` finding removed |

The first measurement used a stale local npx cache (CLI 12.2.0), and both
ratchets correctly ABSTAINED. I re-measured with 12.7.0 pinned explicitly.
