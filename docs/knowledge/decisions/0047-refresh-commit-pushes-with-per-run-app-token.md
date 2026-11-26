---
number: 0047
title: The refresh commit pushes with a per-run GitHub App token
date: 2026-11-25
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/1616
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0047 — The refresh commit pushes with a per-run GitHub App token

**Status:** accepted **Date:** 2026-11-25 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1616](https://github.com/bop-clocktower/canary/issues/1616) (this decision);
issue #1591 (the refresh commit starts no required check); #1463 (CWE-250, the
read-only `measure` / write-only `push` split); PR #1615 (the
`ci-remedy-comment` mitigation); ADR 0011 (required status checks)

## Context

The `refresh-baseline` label runs `.github/workflows/refresh-arch-baseline.yml`.
Its `push` job commits the refreshed `.harness/arch/baselines.json` (and
`.harness/audit.log`) to the PR branch with `GITHUB_TOKEN`. GitHub starts no
`push` or `pull_request` workflow for a push made with that token. So the
required checks never run on the refreshed head, and the PR stays BLOCKED on the
results of the commit before it (#1591, seen on PR 1581, where the bot commit
`9e37cf78` started nothing and a human empty commit `67b02000` was needed).

Why that blocks a merge here:

- Every required check is produced by a workflow that runs on `pull_request`
  (ADR 0011, part 1; `ts/test/workflow-false-green.test.ts` holds it). None of
  them has another trigger that would cover the refreshed head.
- `strict` is true on ruleset 16189198 (`.github/required-checks.json`,
  `mergePolicy`), so the PR must also be green on its current head, not an older
  one.

The current state of the workflow, on `origin/main` 07256a2c:

- #1463 (CWE-250) split it into a read-only `measure` job that runs the floating
  `@harness-engineering/cli@14` and the PR-head
  `scripts/refresh-arch-baseline.mjs`, and a `push` job that is the only holder
  of `contents: write`. `push` runs checkout, download-artifact, a shell restore
  step that validates the artifact byte by byte, and `git`. It runs no registry
  code and no PR-head code, and `git` reads no hooks because a checkout does not
  populate `.git/hooks`.
- `consume-label` and `ci-remedy-comment` each hold only `pull-requests: write`.
  `ci-remedy-comment` (PR #1615) runs when `push` reports `pushed=true` and
  posts the remedy on the PR: an empty commit, or `gh pr update-branch <N>`.
  `AGENTS.md` and the workflow header say the same thing.
- No workflow in the repository mints a GitHub App token today, and the only
  repository secret any workflow reads is `CANARY_PROPRIETARY_DENYLIST` in
  `leak-gate.yml`.

So the label is presented as a one-step fix for a stale arch floor, but every
refresh needs a second, human push. An agent waiting on CI for the refreshed
head waits until it times out unless it knows to make that push. Issue #1616
asked how the refresh commit should start the required checks. The maintainer
chose at the fleet CONFIRM gate (fleet-command run fc1125); this record writes
that choice down for sign-off.

## Decision

**The `push` job pushes the refresh commit with a GitHub App installation token
that it mints for itself on each run.** A push made with an installation token
fires `pull_request: synchronize`, so the required checks run on the refreshed
head and the label becomes one step again.

The shape:

1. **A dedicated GitHub App, installed on this repository only, with one
   repository permission: Contents read and write** (plus the Metadata read that
   every App gets). It has no Pull requests, Workflows, Actions or
   Administration permission.
2. **The token is minted inside `push`, per run.** `push` exchanges the App's
   private key for an installation token at the start of the job, narrowed to
   this repository and `contents: write`. The token expires after about an hour,
   and it is revoked when the job ends. It is used for the checkout's remote and
   for `git push`; nothing else in the job sees it.
3. **Only `push` holds it.** `measure` keeps `contents: read` and no secret.
   `consume-label` and `ci-remedy-comment` keep `GITHUB_TOKEN` with
   `pull-requests: write`. The #1463 invariant still holds: no job that holds a
   write credential runs registry code or PR-head code. `push` is that job, and
   its steps do not change apart from the token it pushes with.
4. **The App is not a bypass actor.** It is on no ruleset bypass list, so its
   commit goes through the same required checks as anyone else's. That is the
   point of the change.
5. **No trigger loop.** `refresh-arch-baseline.yml` runs only on
   `pull_request: labeled`, and `consume-label` removes the label after a
   successful push. The App's push fires `synchronize`, which this workflow does
   not listen to.
6. **Dependabot.** Runs whose triggering actor is Dependabot read Dependabot
   secrets, not Actions secrets. Either the App key is stored in both secret
   stores, or Dependabot PRs keep the #1615 remedy. See the assumptions below.
7. **The #1615 remedy stays, as the fallback.** When the key is not available to
   a run, `push` pushes with `GITHUB_TOKEN` as it does today, emits a
   `::warning::` that names the reason, and `ci-remedy-comment` posts the
   remedy. When the App token was used, no remedy comment is posted.

This record decides the approach. It changes no workflow. Building it is
follow-up work under #1616.

**Assumptions made** (routine defaults taken from the recommended option; each
is open to change at sign-off):

- A1. The token is minted with GitHub's own `actions/create-github-app-token`,
  pinned like the repo's other actions, with its inputs narrowing the token to
  this repository and `contents: write`, and with its default end-of-job
  revocation left on.
- A2. The App is owned by the account that owns `bop-clocktower/canary` and is
  used for nothing else, so its key can be rotated or revoked without affecting
  anything else.
- A3. The App's ID and private key are stored as Actions repository secrets. It
  is [UNVERIFIED] which secret store a run reads when a human applies the label
  to a Dependabot PR: GitHub picks the store by the run's triggering actor, and
  a re-run keeps the original actor. The implementation stores the key in the
  Dependabot store too, unless the maintainer decides at sign-off that
  Dependabot PRs keep the #1615 remedy. Either outcome is acceptable under this
  decision; both are covered by the fallback in point 7.
- A4. A missing or unusable key degrades to today's behaviour loudly (point 7)
  rather than failing the run. The refreshed baseline is still worth pushing;
  the cost of the fallback is the human push this record exists to remove, and
  the warning plus comment make that visible.
- A5. The commit author stays `github-actions[bot]` as configured today; only
  the pushing credential changes. Who is shown as the pusher is cosmetic and is
  left to the implementation.

## Consequences

**What this partially reverses from #1463 (CWE-250).** #1463 removed every
long-lived write credential from this workflow, and its comment in the workflow
names an App token or PAT as exactly what it took out. This decision puts a
long-lived secret back: the App's private key. The token it mints is
short-lived; the key is not.

**Why the exposure is bounded.**

- The key is read only in `push`, which runs no registry code and no PR-head
  code (the #1463 split is kept, and `ts/test/workflow-hygiene.test.ts` holds
  it). The floating CLI and the PR-head refresh script, the two entry points
  #1463 named, still run in `measure`, which has no secret and a read-only
  token.
- The minted token can write repository contents on this one repository and
  nothing else. It cannot edit PRs, workflows, rulesets, settings or other
  repositories, and it expires within about an hour, earlier when the job ends.
- The App is not a bypass actor, so a push with the token cannot land anything
  on `main`. `main` stays behind the PR requirement and the required checks.
- Residual risk, stated plainly: Actions secrets are available to any workflow
  that runs from a branch of this repository. Someone with write access can add
  a workflow on a branch that reads the key. That person can already push to
  this repository, so the key adds little to what they can do, but a leaked key
  lets someone outside mint tokens until it is rotated. The key is the asset to
  protect.

**Human setup steps** (the implementation cannot do these):

- Create the App with only the Contents read-and-write permission, and install
  it on this repository only.
- Generate a private key and store it, with the App ID, as Actions secrets, and
  also as Dependabot secrets if A3 is taken.
- Agree a rotation cadence and a revocation runbook. GitHub Apps allow two keys
  at once, so a rotation is: add a key, update the secret(s), delete the old
  key. A suspected leak is answered by deleting the key, which stops any new
  token being minted; a token already minted stays valid until it expires, at
  most about an hour.
- Confirm the App is on no ruleset bypass list.

**What changes downstream.**

- `ci-remedy-comment` becomes the fallback path, not the main one. It posts only
  when the push did not use the App token.
- `AGENTS.md` ("The label's refresh commit does not re-run the required checks")
  and the header comments of `refresh-arch-baseline.yml`, including the
  `ci-remedy-comment` job comment, describe today's behaviour and become wrong
  once this is built. They change with the implementation, not with this record.
- `ts/test/workflow-hygiene.test.ts` and
  `ts/test/refresh-baseline-push-job.test.ts` need cases for the new shape: the
  key is referenced only in `push`, the minted token is narrowed, and the
  fallback posts the remedy.
- `.github/required-checks.json` does not change: the four jobs stay advisory,
  and no required check is added or removed.
- Once this is built and seen working on a labelled PR, a maintainer can mark
  #1591 done by hand. This record does not do that, and neither does #1616 by
  itself.

**Positive.** The label is one step again. An agent waiting on CI for the
refreshed head gets a run, and the strict required checks report on the tree
that will merge.

**Negative.** One more secret to store, rotate and protect, and a one-time App
setup. A Dependabot gap remains if the key is kept out of the Dependabot store.

## Alternatives Considered

### A: Dispatch the required workflows on the PR head

After `push`, run `workflow_dispatch` (or `gh workflow run --ref <branch>`) on
each required workflow. Not chosen. The required workflows are written for
`pull_request` context: they read `github.event.pull_request.*`, the base SHA
and merge-base comparisons, and PR Guardian depends on it. Each would need a
second, dispatch-only path that rebuilds that context from inputs, which is a
large rework across every workflow in `.github/required-checks.json`'s required
set, and two code paths per check for ADR 0011's false-green test to keep
honest. A dispatched run also reports its checks against the branch head, and
whether ruleset 16189198 counts those check runs for the PR is unconfirmed.
`workflow_dispatch` also needs `actions: write` in the dispatching job, a scope
this workflow does not hold today.

### B′: Push with a write deploy key

Push over SSH with a deploy key that has write access. Pushes made with a deploy
key do fire `synchronize`, and a deploy key has no API scope at all, which is
narrower than an App token in one respect. Not chosen. A deploy key does not
expire and is not minted per run: the credential `push` uses is the long-lived
secret itself, not a one-hour token derived from it. Rotation is a manual
replace with no overlap window, and a leaked key keeps working until someone
notices. A deploy key is also repository-wide write over SSH, with no permission
model to narrow it further.

### C: Keep the #1615 mitigation as documented behaviour

Accept the human push, keep `ci-remedy-comment` as the main path, and treat
issue #1591 as documented behaviour. Not chosen. It keeps #1463's posture intact
and needs no secret, which is its real strength. But every labelled refresh
still needs a second push, the label is not the one-step fix it is presented as,
and an agent waiting on CI has to know about the remedy or it waits until it
times out. Under strict required checks that cost recurs on every refresh. This
decision keeps C as the fallback (Decision, point 7), so its behaviour is still
what happens when the key is not available.
