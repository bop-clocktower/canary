---
number: 0023
title: Leak gate runs on pull_request_target and never executes head code
date: 2026-09-14
status: accepted
tier: medium
source: '#843'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0023 — Leak gate runs on pull_request_target and never executes head code

**Status:** accepted **Date:** 2026-09-14 **Related:** #843, #831, #844, ADR
0011

## Context

**Related:** #843 (source issue); #831 (the Dependabot half, fixed by adding the
secret to the Dependabot store); #844 (the interim fork disclosure in
`CONTRIBUTING.md`); ADR 0011 (required status checks).

`No removed-symbol or proprietary leaks` is a required check
(`.github/required-checks.json`, workflow `docs-lint.yml`) on a public
repository. Its job, `removed-symbols`, runs on `pull_request` and reads
`secrets.CANARY_PROPRIETARY_DENYLIST`. `.proprietary-denylist` is gitignored, so
that secret is the gate's only source of patterns in CI. When the secret does
not resolve, the authorship scan abstains and the step fails (#784). That is
correct: a gate that matches zero patterns has verified nothing.

GitHub does not pass secrets to `pull_request` runs triggered from a fork, and
forks have no secret store of their own (Dependabot does, which is why #831
could be fixed). As a result, no fork PR can ever satisfy this required check.
The fix has to change **where the gate runs**, not which store it reads.

The job needs only data: commit metadata for the PR range (author, committer,
`Co-authored-by:` trailers) and the contents of changed files to grep. It does
not need to install, build or run anything from the PR.

Two base-context triggers can give it the secret:

|                                        | `pull_request_target`                                                                              | `workflow_run` (after a `pull_request` run)                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Secrets on fork PRs                    | Yes, base repo                                                                                     | Yes, base repo                                                                                                                  |
| Check lands on the PR                  | Yes, natively, as the job name                                                                     | No. It needs a manual commit status on the head SHA under the exact required context string                                     |
| Moving parts                           | One workflow                                                                                       | Two workflows plus a status-post step with `statuses: write`                                                                    |
| Failure mode if miswired               | Pwn-request if head code is executed                                                               | Pwn-request risk too (artifacts from the untrusted run), plus a required context that never arrives and blocks every PR forever |
| Workflow file used                     | The one on the base branch, so a PR cannot edit its own gate                                       | The one on the default branch                                                                                                   |
| `ts/test/workflow-false-green.test.ts` | Still sees a PR-triggered producer (the test needs a small update to accept `pull_request_target`) | Producer is indirect, so the test cannot see it without new logic                                                               |

The human decision for #843 is to start from `pull_request_target`.

## Decision

Move the `No removed-symbol or proprietary leaks` job to a `pull_request_target`
trigger, and keep the exact job `name:` so the check context stays
byte-identical to the entry in `.github/required-checks.json` and
ruleset 16189198.

**The rule: under base-repo secrets, this workflow never checks out, installs,
builds or runs head code.** In concrete terms:

1. `actions/checkout` checks out the **base** ref only, which is the
   `pull_request_target` default. It never sets `ref:` to the PR head or merge
   ref.
2. Head commits are reached only **as data**: through the GitHub API, or with
   `git fetch` of the head SHA into the object store, then inspected with
   `git log`, `git show` or `git cat-file`. Nothing is ever checked out into the
   working tree.
3. Changed file contents are grepped as data, from blobs or API responses. No
   script, config, `package.json`, lockfile or hook from the head is read as
   code or executed. The scanner that runs is
   `scripts/check_removed_symbols.mjs` **from base**.
4. No `npm install`, build step, or `setup-node` cache keyed on head files.
5. Permissions are the minimum: `contents: read`, `pull-requests: read`.

Two properties already in the gate must survive the move:

- **Loud abstention.** If the denylist does not resolve, the scan still abstains
  and the job fails. It never falls back to a pass or a skip.
- **Stable context.** The check name stays exactly
  `No removed-symbol or proprietary leaks`. A renamed or missing required
  context blocks every PR.

We reject `workflow_run`. It closes the same secret gap, but it adds a
hand-posted commit status that has to match the required context string exactly.
That is a second place for the name to drift, and a silent way for branch
protection to wait forever.

This record covers only the decision. The workflow change is separate work
tracked in issue #843.

## Consequences

### Positive

- Fork, Dependabot and same-repo PRs all resolve the denylist from **one**
  Actions secret, so the Dependabot-store copy from #831 becomes redundant and
  can be retired later.
- Once the change is verified, outside contributions become mergeable, and the
  fork section of `CONTRIBUTING.md` (#844) can be removed along with
  `ts/test/contributing-fork-note.test.ts`.
- The gate definition comes from base, so a PR cannot weaken its own leak check.

### Negative / risks

- `pull_request_target` combined with secrets is the classic pwn-request shape.
  The safety rule is a code-review invariant, not something the platform
  enforces. The workflow should state it in a comment, and a test should ideally
  enforce it (for example, fail if this job's checkout sets a head `ref` or if
  it runs an install step).
- Changes to the gate in a PR no longer take effect on that same PR, because
  base's copy runs. A PR that edits the scanner is checked by the old scanner
  until it merges.
- `ts/test/workflow-false-green.test.ts` currently requires `pull_request`
  producers. It has to learn that `pull_request_target` is also unconditional.
- Range logic changes: `github.event.before` does not exist on this event, and
  the scan has to take base and head SHAs from `github.event.pull_request`.

### Verification

- The acceptance criterion needs a **real fork PR**, not a simulated one. It has
  to show a non-abstaining green with a non-zero `commit(s) checked`, and a
  planted denylist term on a fork PR has to fail. This cannot be proven from a
  same-repo branch, so a fork must exist and be used before #843 closes.

### Assumptions made

- The scanner only needs commit metadata and file contents, and never runs
  repository code. This is based on the current job, which runs one node script
  with no install step.
- Keeping the job `name:` unchanged under a new trigger keeps the check context
  the same for branch protection. The real fork PR will confirm this.
- Only the leak job moves. The other `docs-lint.yml` jobs stay on
  `pull_request`, because they need no secrets.
