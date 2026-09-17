# Plan: Real-World Function Examples — Batch 10

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: task steps mix long prose/command lines
     with label-then-list blocks (**Files:** followed by a list), matching the
     batch-9 plan's MD013/MD032 relaxation for working docs. The example files
     this plan produces (prompt.txt, README.md) are NOT exempt — they must
     pass prettier/markdownlint on their own, per Task 4. -->

**Date:** 2026-09-17 | **Spec:**
`docs/changes/realworld-functions-batch10/proposal.md` | **Ideation:**
`docs/ideation/realworld-function-batch10-2026-09-17.md` | **Tasks:** 5 |
**Time:** ~30 min | **Integration Tier:** small

## Goal

Add two new prompt-only example directories (`topological-task-order`,
`percentile-nearest-rank`) to `examples/realworld-functions/`, each with a
template-faithful `prompt.txt` + `README.md`, cataloged in both README tables,
verified green by the existing structural test and the four gates.

This is **not** a TDD code-writing task. There is no application code to
implement or unit-test — the deliverable is prompt/doc content, and the only
"test" involved is the repo's own structural guard
(`ts/test/examples-catalog.test.ts`), which already exists and is run unmodified
in Task 4. The guard is genuinely red before Task 3: a new example directory
with no catalog row fails `each example is linked in the catalog`. That
red-then-green ordering is this change's TDD equivalent, and Task 1's Step 3
records it rather than assuming it.

## Observable Truths (Acceptance Criteria)

1. `examples/realworld-functions/topological-task-order/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases matching the
   spec's Technical Design section.
2. `examples/realworld-functions/percentile-nearest-rank/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases matching the
   spec's Technical Design section, and its rules pin both numeric contracts
   (integer `values`, integer `p` in `[0, 100]`) explicitly (S4).
3. Both `examples/realworld-functions/README.md` and `examples/README.md` list
   both new examples in their catalog tables.
4. `npm test -- examples-catalog` passes from `ts/` (all subtests green,
   including the two new example dirs).
5. All four gates pass from `ts/`: `npm run build`, `npm run typecheck`,
   `npm run format:check`, `npm test`.
6. The catalog's framework mix after this batch is 10 pytest / 11 vitest (21
   total) — matching the spec's stated success criterion.

## Uncertainties

- [ASSUMPTION] Canary's request-classification tag (the "Classify the request as
  `X`" line in each README's "What Canary should produce" section) is
  illustrative, not verified by any test. This plan uses `api` for
  `topological-task-order` (structured `dict`-shaped input, matching the
  `lego-tracker-reconcile-collection` / `fifo-lot-consumer` precedent) and
  `frontend_unit` for `percentile-nearest-rank` (pure scalar-returning function,
  matching the `bytes-humanizer` / `money-allocator` precedent). Cosmetic if
  off.
- [ASSUMPTION] Exact generated test file names Canary would pick
  (`test_order.py`, `percentile.test.ts`) in each README's "What Canary should
  produce" section are illustrative only — not verified by any test, cosmetic if
  off.
- [ASSUMPTION] The batch-9 plan ran
  `uv run pytest tests/unit/test_examples_catalog.py` and
  `npx markdownlint-cli`. The Python tree was removed at v6.0.0 and the catalog
  guard now lives at `ts/test/examples-catalog.test.ts`; there is no `lint`
  script in `ts/`. This plan runs the current four gates from `ts/` instead.
  Verified against the worktree before writing, not inherited from the batch-9
  plan.
- [DEFERRABLE] `path-normalizer-posix` (ideation rank 3, score 4.00) is the
  pre-vetted first candidate up if a future batch takes three. Not in scope
  here.

## File Map

- CREATE `examples/realworld-functions/topological-task-order/prompt.txt`
- CREATE `examples/realworld-functions/topological-task-order/README.md`
- CREATE `examples/realworld-functions/percentile-nearest-rank/prompt.txt`
- CREATE `examples/realworld-functions/percentile-nearest-rank/README.md`
- MODIFY `examples/realworld-functions/README.md` (2 catalog rows)
- MODIFY `examples/README.md` (2 catalog rows)

## Skeleton

_Not produced — task count (5) is below the standard-rigor threshold (8)._

## Tasks

### Task 1: Create `topological-task-order/` (prompt.txt + README.md)

**Depends on:** none | **Files:**
`examples/realworld-functions/topological-task-order/prompt.txt`,
`examples/realworld-functions/topological-task-order/README.md`

- [ ] **Step 1:** Create `prompt.txt` with the signature, the five rules
      (eligibility, lexicographic tiebreak, unknown-prerequisite rejection,
      cycle rejection, purity), the headline invariant, and the 8 numbered cases
      from the spec's Technical Design — each written as a literal
      `order({...}) -> [...]` call with concrete task names, so the expected
      value is assertable by equality rather than by "any valid order".
- [ ] **Step 2:** Create `README.md` following the locked template: summary →
      "Python unit example" paragraph naming the counterintuitive edge
      (dependency order beats lexicographic order; case 5's interleaving) →
      Prompt (verbatim copy of `prompt.txt` in a `text` fence) → Run it → What
      Canary should produce (two illustrative `python` assertions, one for the
      tiebreak, one for the cycle rejection) → Running the generated test →
      Variations to try → See also.
- [ ] **Step 3:** Record the guard going red before the catalog row exists:
      `cd ts && npm test -- examples-catalog` — expect
      `each example is linked in the catalog` to FAIL naming
      `topological-task-order`. This is the red half; do not fix it here.

### Task 2: Create `percentile-nearest-rank/` (prompt.txt + README.md)

**Depends on:** none | **Files:**
`examples/realworld-functions/percentile-nearest-rank/prompt.txt`,
`examples/realworld-functions/percentile-nearest-rank/README.md`

- [ ] **Step 1:** Create `prompt.txt`. The rules block MUST pin, in this order:
      (a) `values` is a non-empty array of integers; (b) `p` is an integer in
      `[0, 100]`; (c) anything else throws rather than coercing; (d) sort a copy
      ascending; (e) `rank = ceil((p * N) / 100)` with the multiply performed
      **before** the divide, clamped to `[1, N]`; (f) return the element at that
      1-based rank; (g) the function is pure. Rules (a)-(c) are the S4 numeric
      pin and are not optional.
- [ ] **Step 2:** Write the 8 numbered cases from the spec's Technical Design,
      each carrying its hand-verified arithmetic inline
      (`p=40 -> 200/100 = 2, ceil = 2 -> 20`) so a reader can check the expected
      value without running anything.
- [ ] **Step 3:** Create `README.md` following the same locked template, with
      the summary paragraph naming the exact-multiple discontinuity (case 2) and
      the sort-a-copy purity check (case 6) as the two assertions naive
      implementations miss.
- [ ] **Step 4:** Re-verify every case's arithmetic by hand against the pinned
      formula before moving on. A wrong expected value in a prompt teaches the
      wrong contract and no gate in this repo would catch it.

### Task 3: Add catalog rows to both README.md files

**Depends on:** Task 1, Task 2 | **Files:**
`examples/realworld-functions/README.md`, `examples/README.md` | **Category:**
integration

- [ ] **Step 1:** In `examples/realworld-functions/README.md`, append two rows
      to the `## Catalog` table after the `luhn-card-validator` row, before the
      `## How these differ from the top-level examples` heading.
- [ ] **Step 2:** In `examples/README.md`, append the same two rows (with the
      `realworld-functions/` path prefix) to the
      `## Real-world function examples` table, after the `luhn-card-validator`
      row.
- [ ] **Step 3:** Both rows use the established 4-column shape:
      `| [name](path/) | Unit | Pytest\|Vitest | one-line "what it demonstrates" |`.

### Task 4: Verify — structural test + four gates

**Depends on:** Task 3 | **Files:** none (verification only)

- [ ] **Step 1:** Run the structural catalog test from `ts/`:

```bash
cd ts && npm test -- examples-catalog
```

Expect: all subtests pass, including `each example has prompt.txt`,
`each example has README.md`, and `each example is linked in the catalog` for
both new directories. This is the green half of Task 1 Step 3.

- [ ] **Step 2:** Run prettier's writer over the touched markdown, then the four
      gates from `ts/`:

```bash
npx prettier --write examples/realworld-functions/topological-task-order/README.md examples/realworld-functions/percentile-nearest-rank/README.md examples/realworld-functions/README.md examples/README.md docs/changes/realworld-functions-batch10/proposal.md docs/ideation/realworld-function-batch10-2026-09-17.md
cd ts && npm run build && npm run typecheck && npm run format:check && npm test
```

NOTE: `docs/roadmap.md` is NOT touched by this change and must never be passed
to prettier — it wraps rows and breaks the one-line field contract test.

- [ ] **Step 3:** Confirm the framework mix: count `Vitest` vs `Pytest` rows in
      `examples/realworld-functions/README.md` — expect 11 vitest / 10 pytest
      (21 total), matching the spec's stated success criterion.

- [ ] **Step 4:** Confirm no ratchet surface was added: the change creates no
      `ts/src` module, no `.test.ts` file, and no `scripts/lib/*.mjs`, so the
      entropy `entryPoints` arrays, dead-export check, perf-complexity ratchet
      and architecture allowance/floor all stay untouched. Verify with
      `git diff --stat origin/main` that every changed path is under `examples/`
      or `docs/`.

- [ ] **Step 5:** If any check fails, fix the specific file and re-run — do not
      proceed to Task 5 until all are green.

### Task 5: Provenance, commit, and open PR

**Depends on:** Task 4 | **Files:**
`docs/changes/realworld-functions-batch10/provenance.json`

- [ ] **Step 1:** Write `provenance.json` recording issue `[602]`, route
      `feature`, the stages actually run, the plan path, the assumptions from
      this plan's Uncertainties section, and the closing keyword with its
      reason.
- [ ] **Step 2:** Run
      `harness waypoint record-provenance docs/changes/realworld-functions-batch10/provenance.json`
      (expected to be a no-op — no `waypoint.sink` is configured).
- [ ] **Step 3:** Commit on `feat/602-realworld-functions-batch10` with
      conventional-commit subjects and no co-author trailer. Never
      `--no-verify`.
- [ ] **Step 4:** Push and `gh pr create` with an "Assumptions made" section.
      Use **`Refs #602`** — #602 is an ongoing issue by design (continuous
      batches), and a closing keyword would end the standing series.
- [ ] **Step 5:** Watch CI to green with `gh pr checks <n> --watch`; fix any red
      on the branch. Do not merge.

## Success Criteria

- All 5 tasks complete.
- `npm test -- examples-catalog` green from `ts/`.
- All four gates green from `ts/`: build, typecheck, format:check, test.
- Both catalog READMEs list both new examples.
- Catalog framework mix is 10 pytest / 11 vitest (21 total).
- `percentile-nearest-rank/prompt.txt` pins the integer contract on both
  `values` and `p` (S4).
- PR opened against `main` from `feat/602-realworld-functions-batch10` with
  `Refs #602`, not merged.
