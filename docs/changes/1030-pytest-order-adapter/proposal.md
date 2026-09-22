# Applying a `canary order` plan in pytest (#1030)

**Keywords:** test-ordering, pytest, conftest, collection-hook, order-plan,
no-test-lost, cold-start, documented-snippet

> **Status: fork answered at fleet CONFIRM 2026-09-22.** The delivery question
> ("Python package, policy exception, or documented snippet?") was decided by a
> human before this brainstorm ran: ship a **documented conftest snippet**, no
> Python package in this repo's build, no policy exception. Section
> [Decisions made](#decisions-made) records it as D1.

## Overview

[#1030](https://github.com/bop-clocktower/canary/issues/1030), split from #460
phase 3 (D4), asks for the pytest half of the runner adapters: apply a
`canary order` plan to a pytest run. `canary order --json` already emits
`entries[].test_file` repo-relative
([docs/guides/order.md](../../guides/order.md)), and
[`ts/src/analysis/order/apply.ts`](../../../ts/src/analysis/order/apply.ts) is
the reference semantics — a plan is a _permutation_, a file the plan does not
name goes last in its original order, and nothing is ever dropped. The vitest
sibling
[`vitest-sequencer.ts`](../../../ts/src/analysis/order/vitest-sequencer.ts) is
the shape to mirror: read `CANARY_ORDER_PLAN`, defer to the runner's own order
when the plan is missing or unreadable, and say why on stderr.

### Goals

1. A pytest consumer can apply a `canary order` plan by copying one documented
   `conftest.py` snippet into their own repo.
2. The snippet reorders collected items with `pytest_collection_modifyitems` and
   preserves the collected set exactly — an ordered run and an unordered run
   report the same test count.
3. Files the plan does not name run last, in their original collection order,
   mirroring `applyOrderPlan`.
4. The snippet's behaviour is _executed_, not merely asserted about in prose.

### Out of scope

- A packaged, installable pytest plugin (`pip install canary-pytest`). D1.
- Any Python that canary's own build, lint, or CI executes as product code.
  Canary dropped pytest at v6.0.0; re-adding a Python build surface is a
  separate scope call.
- Test-granularity ranking (`entries[].test_name`). `canary order` emits
  file-granularity entries today; `test_name` is optional in the #460 shape and
  no producer sets it. Ordering by `test_file` only is what the current plan
  supports. Not speculating ahead of the producer.
- Making canary's ranker warm for pytest consumers. No pytest suite in or around
  canary records history, so any pytest consumer is in `declaration` or
  `diff-only` cold-start mode today. That is #460's problem, not this change's.

## Decisions made

| #   | Decision                | Choice                                                                                                                                      | Rationale                                                                                                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Delivery form           | A **documented `conftest.py` snippet** in `docs/guides/order.md`. No Python package, no installable module, no policy exception.            | Decided by a human at fleet CONFIRM. Keeps the standing "all new work is JS/TS" project decision intact, and a conftest is what pytest users copy. |
| D2  | Hook                    | `pytest_collection_modifyitems(config, items)`, sorting `items` in place                                                                    | The only supported pytest hook that reorders collection. #460 phase 3 names it.                                                                    |
| D3  | Never drop, never fail  | A stable sort by plan index, `+inf` for unknown files, ties broken by original index. An unreadable/absent plan leaves order as-is.         | `applyOrderPlan` semantics exactly. A sort is a permutation by construction, which is why the count cannot change.                                 |
| D4  | Key                     | Each item's file path made repo-relative against `git rev-parse --show-toplevel`, POSIX separators                                          | `entries[].test_file` is repo-relative with `/` (ADR 0029). Same normalization the vitest adapter does.                                            |
| D5  | Activation              | Env var `CANARY_ORDER_PLAN`; absent means "do nothing"                                                                                      | Identical to the vitest adapter, so one CI recipe drives both runners.                                                                             |
| D6  | Verification            | A vitest test writes a throwaway pytest suite to a temp dir, copies the snippet **out of the doc**, and runs `pytest` twice for real        | A snippet nobody executed is design intent, not capability. Extracting from the doc also makes doc-snippet drift a test failure.                   |
| D7  | Absent-pytest behaviour | The pytest-executing half is skipped with a printed reason when `python3 -m pytest` is unavailable, and forced by `CANARY_REQUIRE_PYTEST=1` | Canary's CI has no Python. A silent skip would be a zero denominator; naming it keeps the abstention visible.                                      |

### Approaches considered

1. **Documented snippet, executed by a vitest test that extracts it from the doc
   (chosen).** The doc is the single source of the snippet, so it cannot rot
   silently. Cost: the pytest-executing assertions are environment-gated.
   Complexity: low.
2. **Documented snippet, plus a committed `.py` fixture the test runs.** The
   test is simpler, but there are now two copies of the snippet and the doc's
   one is the unverified copy — the exact failure mode #1030 warns about.
   Complexity: low, correctness: worse.
3. **A packaged pytest plugin under `python/`.** What #460 originally imagined.
   Ruled out by D1 (human decision) and by the v6.0.0 pytest removal — adding a
   Python build surface here is a policy change, not an implementation detail.

## Technical design

### The snippet (shape)

A self-contained `conftest.py`, standard library only (`json`, `os`, `pathlib`,
`subprocess`, `sys`), no canary import:

```text
_plan_rank(plan_path) -> dict[str, int] | None   # parse, tolerate any failure
pytest_collection_modifyitems(config, items)     # stable sort in place
```

- Reads `CANARY_ORDER_PLAN`. Unset → return, order untouched.
- Unreadable or not an order plan (`entries` missing, or an entry with a
  non-string `test_file`) → one line on stderr, order untouched. **An unusable
  plan must never block or shrink a run** (the vitest adapter's rule).
- `items.sort(key=...)` where the key is `(rank, original_index)` and `rank` is
  the plan index or `inf`. `items` is mutated in place; no element is added or
  removed, so the collected set is invariant.
- Repo root from `git rev-parse --show-toplevel`, falling back to
  `config.rootpath` when git is absent.

### Verification

`ts/test/order-pytest-conftest.test.ts`:

| Assertion                                           | Runs where              |
| --------------------------------------------------- | ----------------------- |
| The doc contains exactly one `conftest.py` snippet  | everywhere              |
| The snippet compiles (`python3 -m py_compile`)      | wherever python3 exists |
| Ordered run and unordered run report the same count | wherever pytest exists  |
| Plan order is honoured for named files              | wherever pytest exists  |
| Unknown files run last, in collection order         | wherever pytest exists  |
| An unreadable plan leaves the order and count alone | wherever pytest exists  |

The throwaway pytest suite lives in an OS temp dir created by the test, never in
the repo, so nothing Python is added to canary's tracked tree or executed by
canary's own CI.

## Integration points

- **Entry Points:** none in `ts/src`. One new test file, one doc section. No new
  CLI surface, so the new-CLI-surface ratchet checklist does not apply; the new
  `.test.ts` file does need an `entropy.entryPoints` declaration (both arrays).
- **Registrations Required:** `entropy.entryPoints` in `harness.config.json`
  (two arrays kept in sync).
- **Documentation Updates:** `docs/guides/order.md` — a "Applying a plan in
  pytest" section beside the vitest one, and the "pytest and Playwright have no
  adapter yet" line corrected.
- **Architectural Decisions:** none rises to a standalone ADR. D1 is a delivery
  choice recorded here and in the PR, not an architecture change.
- **Knowledge Impact:** "an order plan is applied, never enforced" and "a runner
  adapter degrades to the runner's own order" are now two-runner patterns rather
  than one-off vitest behaviour.

## Success criteria

1. **No test lost.** An ordered and an unordered pytest run of the same
   throwaway suite report the same test count. Executed, not asserted in prose.
2. **Unknown files last.** A file absent from the plan runs after every ranked
   file, in its original collection order.
3. **Degrades, never blocks.** With no `CANARY_ORDER_PLAN`, and with a garbage
   plan, the run completes with the unmodified order and the same count.
4. **The doc is the source.** The executed snippet is extracted from
   `docs/guides/order.md`; editing the doc's snippet changes what is tested.
5. **The decision is recorded.** D1 appears in this spec and in the PR body.
6. **Honest denominator.** When pytest is unavailable the test says so out loud
   rather than passing quietly, and the PR states where the pytest assertions
   did and did not run.

## Implementation order

1. TDD: write `ts/test/order-pytest-conftest.test.ts` against the doc section
   that does not exist yet (red).
2. Write the `docs/guides/order.md` pytest section containing the snippet
   (green).
3. Declare the new test file in both `entropy.entryPoints` arrays.
4. Four gates from `ts/`: build, typecheck, format:check, test. Plus prettier
   and markdownlint on the doc.
