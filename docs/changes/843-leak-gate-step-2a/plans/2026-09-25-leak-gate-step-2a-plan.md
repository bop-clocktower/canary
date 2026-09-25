# Plan: leak gate step 2a (#843)

Spec: `docs/changes/843-leak-gate-pull-request-target/proposal.md`. ADR:
`docs/knowledge/decisions/0023-leak-gate-pull-request-target.md`. This plan
carries out **step 2a** of the Amendment in
`docs/changes/843-leak-gate-pull-request-target/plans/2026-09-15-leak-gate-pull-request-target-plan.md`.
Step 1 merged as PR #948.

## Scope

Rename the `leak-gate.yml` job from
`Leak gate (pull_request_target, transitional)` to the required context name
`No removed-symbol or proprietary leaks`. Nothing else in the job changes.

`docs-lint.yml` keeps its job of the same name, unchanged. That job is what
reports the required check on the 2a PR itself, because `pull_request_target`
runs `main`'s `leak-gate.yml`, which still has the transitional name.

Out of scope, and left for **2b** once 2a is on `main`:

- delete the `removed-symbols` job from `docs-lint.yml`;
- point the manifest's required entry at `leak-gate.yml`;
- flip `ts/test/leak-gate-workflow.test.ts` to assert leak-gate.yml is the only
  producer;
- verify a real fork PR (green with a non-zero commit count, red on a planted
  denylist term, per ADR 0023 Verification);
- then retire the `CONTRIBUTING.md` fork note,
  `ts/test/contributing-fork-note.test.ts`, and the Dependabot copy of
  `CANARY_PROPRIETARY_DENYLIST`.

| #   | Task                                                                                                                              | Files                                                | Verify                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| 1   | Change the step-1 assertions to step 2a: leak-gate.yml's one job is named the required context, and the transitional name is gone | `ts/test/leak-gate-workflow.test.ts`                 | Fails red against the step-1 workflow      |
| 2   | Rename the job and update its comments. Keep the job body byte-identical                                                          | `.github/workflows/leak-gate.yml`                    | Task 1 goes green                          |
| 3   | Drop the transitional advisory entry. Record the 2a to 2b dual-producer window on the required entry                              | `.github/required-checks.json`                       | `workflow-false-green.test.ts` stays green |
| 4   | Gates from `ts/`: build, typecheck, format:check, test                                                                            | —                                                    | All exit 0                                 |
| 5   | Review, provenance, PR (`Refs #843`)                                                                                              | `docs/changes/843-leak-gate-step-2a/provenance.json` | Reviewer passes, CI green                  |

## Between 2a and 2b: two producers, one context

After 2a merges, every same-repo PR and every push to `main` gets two check runs
named `No removed-symbol or proprietary leaks`. Both come from the
`github-actions` app: `docs-lint.yml` on `pull_request` and `leak-gate.yml` on
`pull_request_target`. Measured on PR #1112: the `pull_request_target` run
attaches to the PR head SHA, the same commit the `pull_request` run reports on.
Ruleset 16189198 lists the context with no `integration_id`. How GitHub resolves
two same-named runs from one app on one SHA is **unverified** here: the usual
report is that the most recent run decides, not "any pass" or "all must pass".
Check it on the first PR after 2a merges. Under latest-wins, a PR author can
choose which run lands last (`edited` re-runs `leak-gate.yml`), so a red result
can be non-deterministic until 2b.

- **Same-repo PR, clean:** both pass. Merges as today.
- **Same-repo PR with a real leak:** both scan the same head content, so both
  fail.
- **Fork PR:** `docs-lint.yml` gets no secret and abstains red. `leak-gate.yml`
  gets the secret and can pass. With a red and a green check of one name, a fork
  PR may still be blocked. That is no worse than today, where fork PRs cannot
  pass at all. 2b removes the red producer.
- **PR that edits `scripts/check_removed_symbols.mjs`:** `docs-lint.yml` runs
  the head script and `leak-gate.yml` runs the base script, so they can
  disagree. Security does not regress (today only the head script runs, which
  the PR author controls). But merge availability can: a PR that fixes a scanner
  false positive merges today, and in the window it can go red depending on
  which run lands last. Workaround: re-run the `docs-lint.yml` job so it is the
  newest run, or wait for 2b.
- **The 2a PR itself:** `main`'s `leak-gate.yml` reports the transitional name
  (advisory) and `docs-lint.yml` reports the required context. No deadlock.

The window weakens no protection compared with `main` today. Its costs are one
duplicate job per PR and order-dependent results for fork PRs and
scanner-editing PRs. Keep the window short. 2b should also check whether the
`CONTRIBUTING.md` fork note needs a line for fork PRs that clear during the
window.
