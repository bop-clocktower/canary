# canary-question: pin the failure categoriser and name signals neutrally

**Issues:** #1140, #1142 · **Skill:** `canary-question` (#613)

**Keywords:** canary-question, failure-category, parity-test, signal-id,
no-lean, canary-fail-fast, categorizeFailure

## Overview

Two coupled fixes to
`agents/skills/claude-code/canary-question/scripts/signals.mjs`.

1. **#1140, drift.** canary-question carries its own copy of canary-fail-fast's
   failure-category rules, because skills never import each other. The engine
   port (`ts/src/analysis/enrich/failure-category.ts`) is pinned to the source
   by `ts/test/enrich-failure-category.test.ts`. The skill copy is not; only a
   comment says "Keep the two in sync by hand" (`signals.mjs:92-93`). If a rule
   changes in `failures.mjs`, the store and the evidence brief can disagree
   about the same failure, and no test goes red.
2. **#1142, a one-sided id.** The signal id `category-env` is emitted for
   `timeout`, `auth` and `network`. Two of those three rows also support
   product-defect (`signals.mjs:148-150`, widened in #1137 assumption A9). An id
   that names one hypothesis, next to rows that support another, reads as a
   lean. canary-question must never print a lean (#613, decided 2026-09-29).

Out of scope: the category-to-hypothesis mapping itself. Only the categorisation
is pinned to fail-fast. The mapping is canary-question's own judgment, so it
stays free to differ.

## Decisions made

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Split `category-env` into `category-timeout`, `category-auth` and `category-network`. Each keeps its current support list.                                                                                                                                                                                                                                                                                                                                                                         | Human-approved at fleet CONFIRM. The id names the observation, not a hypothesis. It also matches the existing `category-server`.                                                                                                                               |
| D2  | No deprecated `category-env` alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Human-approved. canary-question shipped in #1137 (2026-09-29), after the last release, v8.0.0 (2026-09-15). Commit `16b70424` is not an ancestor of tag `v8.0.0`, so the old id was never in a published release.                                              |
| D3  | **Behavioural** parity, not byte-identical. The test runs fail-fast's `categorizeFailure` and canary-question's copy over shared samples and requires every result to match. It also asserts that the samples produce all seven categories.                                                                                                                                                                                                                                                        | Human-approved. `signals.mjs` holds far more than the rules (hypothesis mapping, co-failures, paths), so a byte-identical check of the whole file is impossible. The precedent is `ts/test/enrich-failure-category.test.ts`.                                   |
| D4  | The parity test lives in `agents/skills/test/canary-question.test.ts`. It imports fail-fast's `failures.mjs` directly.                                                                                                                                                                                                                                                                                                                                                                             | Skills must not import each other at runtime, but a test may import both sides. It is the file the skills package already runs, so no new test file or entry point is needed.                                                                                  |
| D5  | A naming guard covers every row of the SKILL.md signal table and every row `categoryRows` emits. A signal id **names** a hypothesis when its `-`-separated tokens contain that hypothesis's vocabulary: `env` / `environment` / `infra` for environment, `product` / `sut` for product-defect, and the token pair `test-only` or `test-defect` for test-defect. An id that names a hypothesis must support exactly that one. Every id `categoryRows` emits must also appear in the SKILL.md table. | This is #1142's "done when": the next widening cannot reintroduce the problem. A bare `test` token is not the hypothesis, because every signal is about the test (for example `single-test-run`). Checking against the docs table keeps code and docs in step. |
| D6  | Replace the "Keep the two in sync by hand" comment with a pointer to the parity test.                                                                                                                                                                                                                                                                                                                                                                                                              | Asked for in #1140. A comment is not a check.                                                                                                                                                                                                                  |
| D7  | Add a dated amendment note to `docs/changes/613-canary-question/proposal.md` and update its table. Leave `plans/2026-09-29-canary-question-plan.md` untouched.                                                                                                                                                                                                                                                                                                                                     | The plan is a historical record.                                                                                                                                                                                                                               |

Approaches considered for #1142: (A) a single neutral rename such as
`category-transport`, which is one id but still lumps three different
observations together; (B) a split, chosen in D1. For #1140: (A) byte-identical
extraction of the rules into their own module, kept identical by a test, which
moves code in a shipped skill; (B) behavioural parity, chosen in D3.

## Technical design

- `signals.mjs` `CATEGORY_WEIGHTS`:
  `timeout: ['category-timeout', ['environment', 'product-defect']]`,
  `auth: ['category-auth', ['environment', 'product-defect']]`,
  `network: ['category-network', ['environment']]`. `server` is unchanged.
- The comment above `RULES` points to
  `agents/skills/test/canary-question.test.ts`, which pins the copy to
  canary-fail-fast.
- Tests in `agents/skills/test/canary-question.test.ts`:
  - **parity**: shared samples copied from the engine precedent. For each one,
    `question.categorizeFailure(s) === failFast.categorizeFailure(s)`. The set
    of results equals fail-fast's `FAILURE_CATEGORIES`, so all seven are
    produced.
  - **ids**: the existing `it.each` asserts per-category ids.
  - **naming guard**: D5, run over the parsed SKILL.md table plus `categoryRows`
    for all seven categories.

## Integration points

- **Entry points:** none new. The `--json` / markdown evidence rows carry new
  signal ids, which is a breaking change to unreleased output.
- **Registrations required:** none. No new module or test file, so no entropy
  entry points.
- **Documentation updates:** canary-question `SKILL.md` signal table;
  `docs/changes/613-canary-question/proposal.md` (table and dated amendment);
  `CHANGELOG.md` `[Unreleased]` entry naming the old and new ids and the
  never-released fact.
- **Architectural decisions:** none. This is a small change.
- **Knowledge impact:** none beyond the signal table.

## Success criteria

1. When a rule in canary-fail-fast `failures.mjs` changes without the same
   change in canary-question's copy, a test fails. Shown with a planted mutation
   in the question copy that turns the parity test red, then reverted.
2. The parity samples produce all seven categories, so the check cannot pass
   vacuously.
3. `categoryRows` emits `category-timeout` and `category-auth` (environment and
   product-defect) and `category-network` (environment). It never emits
   `category-env`.
4. No signal id in the SKILL.md table, or emitted by `categoryRows`, names a
   hypothesis it does not exclusively support. The guard is red against the
   pre-change `category-env` rows.
5. The skills package gates (test, typecheck, format:check) and the `ts/` gates
   pass.

## Implementation order

1. Write the tests first: parity, renamed ids, naming guard. Confirm they are
   red where expected.
2. Change `signals.mjs` (ids and comment), then the SKILL.md table. Tests go
   green.
3. Plant the mutation to prove the parity test goes red, then revert.
4. Docs: the 613 proposal amendment and the CHANGELOG entry.
