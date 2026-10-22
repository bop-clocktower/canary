# #1427: concurrency group for force-pushed ledgers

Pipeline: `harness:workflow-audit` (scoped to the force-push / concurrency
check, M4.5), then TDD.

## Audit finding

```text
[WARNING] concurrency-missing  .github/workflows/harness-security.yml:128
  `git push --force origin "HEAD:$BRANCH"` (BRANCH=chore/security-ledger) runs
  on every push to main, and the workflow has no `concurrency:` group.
  Effect: two overlapping push-to-main runs both force-update the ledger
  branch; the last writer wins and the other run's ledger write is lost, with
  nothing going red.
  Patch: job-level concurrency group keyed on the ledger branch,
  cancel-in-progress: false (applied, see below).

[WARNING] concurrency-missing  .github/workflows/release.yml:156
  `git push origin latest --force` in job advance-latest, no group.
  Effect: two stable releases close together race; the slower run can move
  `latest` backwards.
  Patch: job-level group `latest-tag`, cancel-in-progress: false (applied).
```

The second finding was not in the issue. The new invariant found it on its first
run (it is the planted positive, along with harness-security.yml).

## Root cause

A force push is last-writer-wins by design. Without a concurrency group, GitHub
runs overlapping workflow runs in parallel, so the ordering of their pushes is
arbitrary and one run's write is silently discarded.

## Fix

- `harness-security.yml`, job `security`: a job-level `concurrency:` group.
  Push-to-main runs share `ledger-chore/security-ledger`; every other run gets
  `security-<run_id>`, a group of its own.
  - Why job-level and conditional, not a plain workflow-level group: the same
    job runs on `pull_request` and is the required `security` check. A plain
    group would make PR runs queue behind main and behind each other. GitHub
    keeps only one pending run per group, so a third queued run would cancel the
    pending one, and a cancelled required check blocks the PR. The conditional
    group keeps PR behaviour exactly as it was.
  - The group name is a literal, not `env.BRANCH`: `jobs.<id>.concurrency` has
    no `env` context.
- `release.yml`, job `advance-latest`: group `latest-tag`.
- `cancel-in-progress: false` in both, so a running push is never killed.

## Tests added (`ts/test/workflow-hygiene.test.ts`)

`describe('#1427 a workflow that force-pushes declares a concurrency group')`:

1. The force-push detector is table-tested: `--force`, `--force-with-lease`,
   `-f`, `+refspec` are force; a plain push and `--follow-tags` are not.
2. Denominator: the scan must find `arch-snapshot.yml job snapshot` and
   `harness-security.yml job security`, so a detector regression cannot make the
   invariant pass vacuously.
3. Invariant: every job whose `run:` force-pushes has a job- or workflow-level
   `concurrency:` with a group and without `cancel-in-progress: true`.

Red before the fix: test 3 failed with
`["harness-security.yml job security", "release.yml job advance-latest"]`. Green
after.

## Assumptions and defaults taken

- The human decided the fix shape (concurrency group,
  `cancel-in-progress: false`). "None is dropped" holds for two overlapping
  runs. With three, GitHub replaces the pending run with the newest one. For
  this ledger that is acceptable: the ledger branch is rebuilt from the run's
  checkout of `main` each time, so the newest run's ledger supersedes the older
  one. The cancelled middle run is a push-to-main run, not a PR check, so it
  blocks nothing.
- `release.yml` was changed even though the issue named only
  `harness-security.yml`, because the invariant the human asked for covers every
  force-pushing workflow, and an allowlist entry would leave a known race
  unguarded. It is flagged in the PR body.
- The detector reads `run:` scripts only. A force push from inside a called
  script (e.g. `node scripts/x.mjs`) is not seen. No workflow does that today.
- Coordination: #1428 stacks on this branch and adds its own `describe` block to
  the same file; this change is one self-contained `describe`. Lane #1426 edits
  harness-security.yml permissions; this change touches only the `security`
  job's `concurrency:` key and does not touch `permissions:`.
