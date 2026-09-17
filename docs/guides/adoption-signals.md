# Adoption Signals Guide

`canary adoption` answers one question about the repository it runs in: **is
anyone acting on the guardian's findings?** It measures abandonment rather than
satisfaction. People who stopped trusting a tool rarely file feedback, so the
report uses signals that need nobody to do anything (#491).

## What it sends: nothing

The report runs entirely on your machine. It reads files and local git history,
prints, and exits 0. It makes no network call, not even a read from the GitHub
API. The `--json` output says so in a field: `"egress": "none"`.

These numbers describe **your** repository's behaviour. Sending any of them
anywhere would be telemetry, so a future sharing feature must be a separate,
explicit opt-in. It must follow the consent pattern that
`.harness/hooks/telemetry-reporter.js` already sets (opt-in plus a one-time
notice) and the `canary feedback` privacy stance (never environment variables or
file contents). No such feature exists today.

## How to turn it off

Nothing runs unless you run it. To stop the underlying data from existing,
remove `--emit-analysis` from your `guardian pr-check` invocation, or delete
`.harness/analyses/canary-pr-guardian-*.json`.

## Usage

```bash
canary adoption                      # text report
canary adoption --json               # machine shape
canary adoption --dir path/to/records --branch main
```

- `--dir` (default `.harness/analyses`): where the records are. A CI runner's
  copy is thrown away when the job ends. Point `--dir` at a local checkout's
  records or at downloaded run artifacts.
- `--branch` (default `origin/HEAD`'s target, else `main`): the branch whose
  history decides merge state.

## What is measured

Every signal prints its denominator. A signal with nothing to count prints
`abstained` with the reason. It never prints a zero that looks healthy.

| Signal               | Source                                                                           | Denominator                |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| Guardian workflow    | `.github/workflows/*.y{a,}ml` whose text mentions `guardian pr-check`            | presence only              |
| Workflow disabled    | **not measured**: that state is in the Actions API, which the report never calls | n/a                        |
| Merged over findings | records with `summary.unaddressed > 0` whose PR is merged on the branch          | records resolved as merged |
| Suppressions         | `summary.suppressed` (`canary:allow-untested`) over `summary.total`              | findings                   |
| Gate                 | `gate` per record, plus the gate of the newest record                            | records                    |
| Degradation          | `degradedNotice`, `abstained`, and `tier` per record                             | records                    |
| Findings per PR      | `summary.total`: min, median, p90, max, and the count over 100                   | records                    |

Things to know when you read the numbers:

- The workflow scan is a text match, so a commented-out or `if: false` guardian
  step still counts as present. It answers "is the invocation still in the
  repo", not "did it run".

- Records are one file per ref, overwritten on each run. Each per-PR number
  comes from the **latest run** for that PR.
- **A failed look is never a zero.** If `git log` fails (a bad `--branch`, an
  unfetched remote, not a git repo), the merge signal prints `not measured` with
  git's own error rather than an abstention that asserts something about the
  branch. A missing records directory and a missing `.github/workflows` are both
  named as such, never reported as "empty" or "absent".
- **Merge state comes from local git.** A `pr-<n>` record counts as merged when
  a first-parent subject on the branch ends in `(#<n>)` (squash merge) or starts
  `Merge pull request #<n>`. A rebase-merged PR leaves no marker, so it is
  counted as `unresolved`. The report does not guess. Non-PR refs (a short SHA,
  `local`) are always `unresolved`.
- Files in the directory that are not guardian records are listed as `skipped`
  with a reason. Harness keeps its own records there too.
