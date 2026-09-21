# Real-World Function Examples — Batch 10

**Status:** approved (design sign-off pending) **Type:** docs/examples
(prompt-only) — small change, no production code **Keywords:**
realworld-functions, examples, prompt-only, pytest, vitest, topological-sort,
dependency-graph, percentile, nearest-rank, catalog

## Overview and goals

Add two pure-function examples to `examples/realworld-functions/`, continuing
the prompt-only catalog (`prompt.txt` + `README.md`, no committed tests). Unlike
batch 9, these are **not** drawn from a leftover pool: batch 6's below-the-cut
pool is exhausted, and its two survivors stay rejected on unchanged risks. This
batch comes from fresh ideation at
`docs/ideation/realworld-function-batch10-2026-09-17.md`, which generated and
ranked ten new candidates against a novelty map of the nineteen shipped
examples.

Goal, as in every batch: each example teaches a testing skill the existing
nineteen do not.

Out of scope: implementing the functions (examples are prompt-only), changing
the example template, adding frameworks or property-test libraries (not in the
registry), and every candidate below the cut — see "Candidates rejected" for why
each was cut.

## Decisions made

| Decision                                       | Choice                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch size                                     | 2 (topological-task-order, percentile-nearest-rank)                                                                                                  | Matches batch 9's size; the ideation doc's recommended cut                                                                                                                                                                                                                                                        |
| Framework split                                | 1 pytest + 1 vitest                                                                                                                                  | Takes the catalog to 10 pytest / 11 vitest (21 total) — closer to parity than batch 9 left it (9/10)                                                                                                                                                                                                              |
| topological-task-order: tiebreak               | Among all tasks whose prerequisites are already emitted, take the **lexicographically smallest**                                                     | A valid dependency graph has many valid orders, so an untied contract is untestable by equality. Pinning the tiebreak collapses the output to exactly one assertable list — the same move `dense-rank-leaderboard` makes with tie schemes                                                                         |
| topological-task-order: unknown prerequisite   | Raises `ValueError`, is not silently skipped                                                                                                         | Silently skipping an unknown prerequisite is the failure mode that makes a broken task graph _look_ healthy — precisely the "passes without proving anything" shape STRATEGY.md names                                                                                                                             |
| topological-task-order: numeric contract       | None — the function takes no numeric input                                                                                                           | S4 does not apply. Recorded explicitly so a reviewer does not read the absence as an omission                                                                                                                                                                                                                     |
| percentile-nearest-rank: estimator             | Nearest-rank, with `rank = ceil((p × N) ÷ 100)` clamped to `[1, N]`, multiply performed **before** the divide                                        | Percentile has many published definitions; pinning one to the digit is what keeps the pytest and vitest ports in agreement. Multiplying first keeps the arithmetic exact — at `p=7, N=100`, `(7 × 100) ÷ 100` is exactly `7`, while dividing first gives `7.000000000000001`, which `ceil`s to the wrong rank `8` |
| percentile-nearest-rank: numeric contract (S4) | `values` must be a non-empty array of **integers**; `p` must be an **integer** in `[0, 100]`. Fractional or out-of-range input raises, never coerces | The soundness-required pin. No fractional value ever enters the function, which is exactly what makes the exact integer rank arithmetic sound                                                                                                                                                                     |
| percentile-nearest-rank: purity                | Sorts a **copy**; never mutates the caller's array                                                                                                   | Case 6 (unsorted input) is the case that catches an in-place `sort()`                                                                                                                                                                                                                                             |

## Candidates rejected

Every candidate below the recommended cut, with the reason it was cut. Full
scoring is in the ideation artifact.

| Candidate                 | Score                  | Why cut                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path-normalizer-posix     | 4.00                   | Just below the cut, not disqualified. "Malformed input is rejected, not normalized" is now the catalog's most repeated lesson (`price-normalizer`, `pagination-cursor-codec`, `luhn-card-validator`). **First candidate up if a future batch takes three** |
| bankers-rounding-splitter | 3.00                   | Overlap — exact-sum is `money-allocator`, rounding boundaries are `bytes-humanizer`; half-even alone is too thin a delta                                                                                                                                   |
| run-length-codec          | 3.00                   | Overlap — `decode(encode(x)) === x` plus garbage rejection is `pagination-cursor-codec`'s exact lesson, with a smaller edge surface                                                                                                                        |
| bin-packing-first-fit     | 2.75                   | Overlap — the capacity/conservation invariant is `fifo-lot-consumer`'s, the heuristic-order lesson is `discount-stacking`'s                                                                                                                                |
| weighted-round-robin      | 2.50                   | Overlap — continuous state evolved across calls with an injected input is `token-bucket-rate-limiter`                                                                                                                                                      |
| csv-line-parser           | 1.33                   | **Hard reject — unbounded parsing surface.** Quoted fields, escaped quotes, embedded newlines and dialect flags have no natural stopping point (dropped for the same reason in batch 6)                                                                    |
| ranked-choice-irv         | 1.00                   | **Hard reject — unbounded rule surface.** Exhausted ballots, simultaneous elimination, tie-break-at-elimination and majority-threshold definitions each fork further, and every fork must be pinned or the ports diverge                                   |
| e164-phone-normalizer     | 0.67                   | **Hard reject — unbounded parsing surface plus external data.** Correctness depends on a country-code table that is real-world data, not a pinnable contract                                                                                               |
| truncate-grapheme         | carried, not re-scored | **Hard reject — framework-parity risk.** Grapheme-cluster and surrogate-pair semantics differ between Python `str` and JS UTF-16 strings, so the two ports cannot assert the same expected values                                                          |
| cron-next-fire            | carried, not re-scored | **Hard reject — unbounded parsing surface.** Ranges, steps, day-of-week aliases and the day-of-month/day-of-week OR rule keep expanding the grammar                                                                                                        |

## Technical design

Each example is a directory under `examples/realworld-functions/` containing
`prompt.txt` (signature + rules + 8 numbered cases) and `README.md` (locked
structure: summary → "X unit example" → Prompt → Run it → What Canary should
produce → Running the generated test → Variations to try → See also).

### topological-task-order (pytest)

`order(tasks: dict[str, list[str]]) -> list[str]` — returns a
dependency-respecting execution order for a task graph. Each key is a task name;
its value is the list of task names that must appear before it.

Rules: a task may be emitted only once every one of its prerequisites has been
emitted; among all currently-eligible tasks, the **lexicographically smallest**
name is emitted next; a prerequisite naming a task that is not a key raises
`ValueError`; a cycle (including a self-dependency) raises `ValueError`; the
function is pure and never mutates its input.

Cases: (1) linear chain; (2) all-independent tasks, emitted in lexicographic
order; (3) diamond (one root, two middles, one join); (4) dependency beats
lexicographic order — `{"b": [], "a": ["b"]}` → `["b", "a"]`; (5) two
independent chains **interleaved** by the tiebreak rather than run
one-after-the-other; (6) empty mapping → `[]`; (7) two-node cycle →
`ValueError`; (8) prerequisite naming an unknown task → `ValueError`.

Headline invariant: every task appears exactly once, after all of its
prerequisites — and for a given graph the output is **exactly one** list, not
any valid topological order.

### percentile-nearest-rank (vitest)

`percentile(values: number[], p: number): number` — the p-th percentile of an
integer sample under the nearest-rank method.

Rules: `values` must be a non-empty array of integers; `p` must be an integer in
`[0, 100]`; anything else throws. Sort a **copy** ascending **numerically**
(`(a, b) => a - b`, never a bare `.sort()`), then `rank = ceil((p × N) ÷ 100)` —
multiply before dividing — clamped to `[1, N]`; return the element at that
1-based rank.

Cases (hand-verified; sample `[9, 20, 35, 40, 100]`, `N = 5` — the digit widths
are mixed on purpose so lexicographic order differs from numeric order): (1)
`p=50` → `250÷100 = 2.5`, `ceil = 3` → `35`; (2) `p=40` → `200÷100 = 2` exactly,
`ceil = 2` → `20` (the exact-multiple case that does **not** round up); (3)
`p=100` → `500÷100 = 5` → `100` (a bare `.sort()` returns `9`); (4) `p=0` → rank
`0`, clamped to `1` → `9` (a bare `.sort()` returns `100`); (5) single element
`[7]`, `p=37` → `37÷100 = 0.37`, `ceil = 1` → `7` (the clamp is the only thing
preventing an out-of-range index); (6) unsorted `[100, 9, 40, 20, 35]`, `p=50` →
`35`, and the caller's array is unchanged; (7) empty array → error; (8) invalid
`p` — `101` (out of range) and `50.5` (fractional) → error.

Headline invariant: at an exact multiple the rank does **not** advance, so
`p=30` and `p=40` return the same element on this sample while `p=50` moves on —
a discontinuity only an estimator-aware suite predicts.

## Integration Points

- **Entry Points:** two new example directories under
  `examples/realworld-functions/` (`topological-task-order/`,
  `percentile-nearest-rank/`), each with `prompt.txt` + `README.md`. No new
  TypeScript module, script, or test file — so no entropy `entryPoints` entry,
  dead-export, perf-complexity, or architecture-allowance change is required.
- **Registrations Required:** add one catalog row per example to BOTH
  `examples/realworld-functions/README.md` and `examples/README.md` (the
  structural test `ts/test/examples-catalog.test.ts` enforces the
  realworld-functions-level link).
- **Documentation Updates:** the two catalog READMEs above. No AGENTS.md change.
- **Architectural Decisions:** None (no ADR — small docs change).
- **Knowledge Impact:** None.

## Success criteria

- Two new directories exist, each with `prompt.txt` + `README.md` matching the
  locked template shape (8 numbered cases in the prompt).
- Both catalog READMEs list both; `ts/test/examples-catalog.test.ts` passes.
- The four gates pass from `ts/`: build, typecheck, format:check, test.
- Catalog framework mix after this batch: 10 pytest / 11 vitest (21 total).
- Every numeric case in `percentile-nearest-rank` is reachable under the pinned
  integer contract (S4).

## Implementation order

1. Create the two directories with `prompt.txt` + `README.md`
   (template-faithful).
2. Add catalog rows to both READMEs.
3. Run `ts/test/examples-catalog.test.ts` + the four gates; verify green.
4. Commit on a feature branch; open PR.
