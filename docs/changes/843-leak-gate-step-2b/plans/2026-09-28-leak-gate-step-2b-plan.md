# Plan: leak gate step 2b, one producer for the required context (#843)

**Spec:** `docs/changes/843-leak-gate-pull-request-target/proposal.md`,
ADR 0023. **Previous step:**
`docs/changes/843-leak-gate-step-2a/plans/2026-09-25-leak-gate-step-2a-plan.md`
(its "Out of scope, and left for 2b" list and "Between 2a and 2b" section).
**Base:** `main` at `47745970`, which carries 2a (#1115).

## Goal

After 2a, two workflows report `No removed-symbol or proprietary leaks`:
`docs-lint.yml` (`pull_request`, no secret on a fork PR, so it abstains red) and
`leak-gate.yml` (`pull_request_target`, base context, the secret resolves). 2b
removes the `docs-lint.yml` producer so the context has one source.

The context string does not change, so ruleset 16189198 needs no edit. The
required set stays at 13 contexts. Only the producing workflow of one entry
moves.

## Scope

Decided before planning ("code half, keep fork note"):

- In: delete the `removed-symbols` job from `docs-lint.yml`, point the
  manifest's required entry at `leak-gate.yml` and drop the dual-producer note,
  flip `ts/test/leak-gate-workflow.test.ts` to assert leak-gate.yml is the only
  producer, keep `ts/test/workflow-false-green.test.ts` green, and fix doc drift
  that names `docs-lint` as the leak gate's home.
- Out, and listed in the PR as manual steps: verify a real fork PR per ADR 0023
  Verification, retire the `CONTRIBUTING.md` fork note and
  `ts/test/contributing-fork-note.test.ts`, delete the Dependabot copy of
  `CANARY_PROPRIETARY_DENYLIST`.

## Why the fork-note test stays green without edits

`contributing-fork-note.test.ts` derives its list of blocked checks from the
workflows: a required check that reads a secret under a fork-blind trigger. Once
the `docs-lint.yml` job is gone, that list is empty and the test takes its
"retired itself" branch. The note stays in `CONTRIBUTING.md` on purpose until a
real fork PR proves the gate. That verification is the manual step.

## Tasks

| #   | Task                                                                                                                                                                               | Files                                                                                              | Verify                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Replace the step-2a assertions with 2b ones: the manifest names `leak-gate.yml`, no other workflow produces the context, and `docs-lint.yml` has no job that runs the leak scanner | `ts/test/leak-gate-workflow.test.ts`                                                               | Fails red against the 2a tree, and for the right reason (planted positive) |
| 2   | Delete the `removed-symbols` job from `docs-lint.yml`. Re-point the mermaid job's comment that cited it                                                                            | `.github/workflows/docs-lint.yml`                                                                  | Task 1 goes partly green                                                   |
| 3   | Point the manifest's required entry at `leak-gate.yml` and replace the 2a to 2b note                                                                                               | `.github/required-checks.json`                                                                     | Task 1 all green; `workflow-false-green.test.ts` stays green               |
| 4   | Update the step-2a comments in `leak-gate.yml`. Leave every step unchanged                                                                                                         | `.github/workflows/leak-gate.yml`                                                                  | Safety-invariant tests unchanged and green                                 |
| 5   | Doc drift: the `AGENTS.md` line that says the guard runs via `docs-lint`, the integration guide's list of required workflows, the zero-denominator test's header                   | `AGENTS.md`, `docs/guides/harness-canary-integration.md`, `ts/test/zero-denominator-gates.test.ts` | `doc-links` and AGENTS.md tests green                                      |
| 6   | Gates from `ts/`: build, typecheck, format:check, test. Ratchets vs the merge base: entropy, perf, arch, docs coverage                                                             | —                                                                                                  | All exit 0; no ratchet moves                                               |

## Risks

- **A required context with no producer blocks every PR.** On this PR,
  `pull_request_target` runs `main`'s `leak-gate.yml`, which already reports the
  context (2a). So the context still reports here even though this PR deletes
  the `docs-lint.yml` job. No deadlock.
- **The fork-note test goes quiet.** It is designed to retire itself, so that is
  expected, not a vacuous pass. The note stays until the manual fork-PR check.
