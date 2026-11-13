# Plan: tell a refreshed PR how to re-run its required checks

Refs #1591. Fleet: cicd-fleet, fleet-command run fc1112b. Option: F1-A (chosen
by the human: Q1 = a).

## Root cause

`refresh-arch-baseline.yml` job `push` commits the refreshed baseline as
`github-actions[bot]` and pushes it with `github.token`. GitHub starts no `push`
or `pull_request` (`synchronize`) workflow for a push made with `GITHUB_TOKEN`.
That rule exists to stop recursive runs. So the 13 required checks on ruleset
16189198 (strict) never run on the refreshed head. The PR stays BLOCKED on the
results of the commit before the refresh. Seen on PR 1581 in fc1106: bot commit
`9e37cf78` started no required check, and an empty human commit (`67b02000`) was
needed.

The `harness:workflow-audit` run over this file found it under M4/J2. The
push-back's "re-trigger guard" is the token rule itself, and here it also stops
the gate the refresh exists to unblock.

## Chosen option: F1-A, comment with the remedy

Keep the least-privilege token model from #1463. No App token, no PAT, and no
`workflow_dispatch` fan-out. After a push that actually pushed, a job holding
only `pull-requests: write` comments on the PR. The comment says the required
checks will not re-run on the bot commit, and gives the remedy:

```bash
git commit --allow-empty -m "ci: re-run checks after baseline refresh" && git push
```

or `gh pr update-branch <N>` when the PR is behind `main`.

The full trigger fix is deferred to a follow-up design issue, and #1591 stays
open until it lands.

## Tasks

1. Run `harness:workflow-audit` over
   `.github/workflows/refresh-arch-baseline.yml`.
2. Write failing tests:
   - `ts/test/workflow-hygiene.test.ts`: `push` exposes a `pushed` output from
     the step that runs `git push`. `ci-remedy-comment` needs `push`, is gated
     `success() && needs.push.outputs.pushed == 'true'`, and holds exactly
     `pull-requests: write`. `push` keeps exactly `contents: write`. The comment
     job runs no registry or checkout code and names both remedies. The #1463
     writer list includes the new job.
   - `ts/test/refresh-baseline-push-job.test.ts`: `push` writes `pushed=true`
     only after a real push, and writes `pushed=false` on the deleted-branch
     skip. The comment job posts to the right PR with the remedy text, and warns
     and stays green when `gh` fails.
3. Implement: the `commit-push` step id, the `pushed` output, and the
   `ci-remedy-comment` job.
4. Classify `ci-remedy-comment` as advisory in `.github/required-checks.json`.
5. Document the remedy in `AGENTS.md`, beside the label's other docs, and in the
   workflow header.
6. Run the local gates from `ts/`, the perf ratchet, markdownlint and
   actionlint. Push, open the PR, file the follow-up, and watch CI.

## Assumptions

- `pull-requests: write` is enough for `gh pr comment` on a PR with
  `GITHUB_TOKEN`. PR comments are issue comments, and the REST endpoint takes
  either the issues or the pull-requests write scope.
- `consume-label` keeps its current gate (`success()`). Gating it on `pushed`
  is item 1 of #1540 and stays out of scope. The output added here makes that
  change a one-liner.
- A failed comment is a warning, not red. The baseline is already pushed, and
  the workflow header and `AGENTS.md` carry the same remedy.
- This cannot be proven end to end before merge. The workflow runs only on the
  label, so its scripts are run locally against a stub `gh`.

## Out of scope

- #1540 item 2: any label cancels a refresh in flight.
- The real trigger fix, an App token or PAT, or dispatching the required
  workflows with PR context. That goes to the follow-up issue.
