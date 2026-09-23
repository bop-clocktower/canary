# Plan — phase 1: catalog account existence (#1100)

Spec: `docs/changes/1100-catalog-account-existence/proposal.md` Route: feature
(brainstorming -> autopilot) Branch: `feat/1100-catalog-account-existence`

Single phase. The change is one core module, its test file, and three SKILL.md
files — below the threshold that would warrant decomposition.

## Requirements (EARS)

- R1. When the catalog reports that none of the configured accounts exist, the
  system shall return status `all-missing` and state that the cause is an
  account problem rather than a test defect.
- R2. When the catalog reports that some configured accounts do not exist, the
  system shall return status `some-missing` and name each missing account.
- R3. When every configured account is known to the catalog, the system shall
  return status `all-present` with `checked` equal to the number of distinct
  configured accounts.
- R4. If no `user_catalog_skill` is configured, or the catalog could not be
  reached, or the catalog reports zero accounts, or zero configured accounts
  were resolved, then the system shall return status `cannot-verify` with
  `checked: 0` and a non-empty reason, and shall not return `all-present`.
- R5. When `.canary/company.json` declares a valid `user_catalog_skill`, the
  loader shall expose it as a merged scalar field.
- R6. If a declared `user_catalog_skill` is not a valid skill slug, then the
  loader shall warn and drop it rather than store it.
- R7. The system shall not name any catalog implementation in its output.

## Tasks (TDD — test precedes implementation in every pair)

| #   | Task                                                                                                                                                    | Verifies   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T1  | Add failing tests for `verifyConfiguredAccounts`: the three decided statuses, de-duplication, case folding                                              | R1, R2, R3 |
| T2  | Add failing tests for all four abstention shapes, each asserting `checked === 0` and a non-empty reason                                                 | R4         |
| T3  | Add a failing test asserting no verdict field contains a catalog implementation name                                                                    | R7         |
| T4  | Add failing tests for `user_catalog_skill`: loaded, cascade-overridden, invalid-value warned-and-dropped                                                | R5, R6     |
| T5  | Implement the `user_catalog_skill` loader field (`_KNOWN_KEYS`, `Layer`, `parseLayer`, `_SCALAR_FIELDS`, `CompanyKnowledgeInit`, class field, `toDict`) | R5, R6     |
| T6  | Implement `verifyConfiguredAccounts` plus its exported types                                                                                            | R1–R4, R7  |
| T7  | Wire the existence check ahead of the suggestion in `canary-ci-ready/SKILL.md`                                                                          | R1–R4      |
| T8  | Wire the same in `canary-failure-impact/SKILL.md`                                                                                                       | R1–R4      |
| T9  | Correct the now-wrong "unknown field" row in `canary-company-knowledge/SKILL.md`                                                                        | R5         |
| T10 | Gates: `build`, `typecheck`, `format:check`, `test` from `ts/`; `check-deps` from the repo root                                                         | all        |

## Checkpoints

- After T4: every new test fails for the right reason (red).
- After T6: unit tests green; this is the earliest point the helper could be
  claimed to work.
- After T10: four gates green plus `check-deps`. A silent gate counts as not
  run.

## Risks

- **Ratchets local gates miss.** No new module and no new `scripts/lib/*.mjs`,
  so the entropy `entryPoints` arrays are untouched; no new CLI surface, so the
  perf delta rule and the arch allowance floor should be unmoved. Verify against
  CI rather than assuming.
- **Exhaustiveness assertions.** Adding a scalar field without listing it in
  `_SCALAR_FIELDS` collapses `CoversAll` to `never` and fails the build. That is
  the intended guard, not a surprise.

## Out of scope

Implementing a catalog; any network call; any new CLI subcommand; changing how
severity is scored in `canary-failure-impact`.
