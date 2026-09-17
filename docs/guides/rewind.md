# canary rewind

Rerun one failed test from run history at the commit it failed on, and report
exactly what of the original run was put back.

`canary rewind` is the replay half of #461. It reads the history store written
by `canary history record`
([ADR 0030](../knowledge/decisions/0030-history-schema-v3-replay-context.md)),
so a run is only as replayable as what was recorded for it.

## Usage

```bash
canary rewind <run_id> --test "<exact test name>"
canary rewind <run_id> --test "<name>" --repeat 5
canary rewind <run_id> --test "<name>" --with-predecessors
canary rewind <run_id> --test "<name>" --json
```

`--path` points at a local store other than
`test-results/reports/history-v2.jsonl`. The remote store cannot return whole
runs yet, so a configured `--db-url` abstains.

## What it does

1. Finds the run and the test, and checks the test failed (or flaked) there.
2. Checks the recorded commit exists locally, and fetches it once from `origin`
   if not. It never falls back to a nearby commit.
3. Checks the commit out into a scratch worktree under the system temp
   directory. Your checkout, branch and worktree list are never touched, and the
   scratch worktree is removed on every exit.
4. Installs dependencies from the old commit's lockfile (`npm ci`,
   `pnpm install --frozen-lockfile` or `yarn install --frozen-lockfile`) when
   the package has no `node_modules`.
5. Runs the test's file `--repeat` times (default 3) with the recorded seed when
   there is one, and reads the test's status from the runner's JSON report.
6. Finds the nearest green run and prints the fidelity table and result.

Vitest and Playwright runs are replayable. JUnit runs abstain: a JUnit file does
not say which command produced it.

## The fidelity table

Every dimension gets exactly one status:

| Status         | Meaning                                                   |
| -------------- | --------------------------------------------------------- |
| `restored`     | The replay put this back as it was.                       |
| `not-restored` | The record holds it, but the replay could not restore it. |
| `not-recorded` | The record never held it, so there is nothing to restore. |

| Dimension     | When `restored`                                                           |
| ------------- | ------------------------------------------------------------------------- |
| `commit`      | Always, once a replay runs (an unreachable commit abstains instead).      |
| `seed`        | A seed was recorded with `--seed` and the runner takes one (vitest only). |
| `order`       | Never. Even with `--with-predecessors` the runner decides the order.      |
| `environment` | Node, OS and arch match the record and dependencies installed.            |
| `network`     | Never. Replays run against live network state.                            |
| `database`    | Never.                                                                    |
| `wall-clock`  | Never.                                                                    |

A differing environment names each key that differs, for example
`node v20.11.0 -> v22.23.2`.

## Results

- `reproduced`: every attempt that ran the test failed.
- `not-reproduced`: every attempt passed.
- `intermittent`: some of each. The output hands off to `canary history flaky`
  and the canary-flake-hunter agent; rewind does not decide flakiness.
- `not-run`: no attempt ran the test, usually because dependencies failed to
  install. See the `environment` row.

Nearest green is the run of the same suite, on first-parent history of the
failing commit, with the fewest commits back, in which the test passed. The
output names it, the commit range between the two, and the recorded duration and
error.

## Exit codes

- `0`: a replay completed, whatever it found.
- `3`: abstained, with an `Abstained:` line saying why. Reasons: the run or test
  is absent, the test did not fail, the commit is `local` or unreachable after
  one fetch, the runner is unsupported, the test file path is not repo-relative
  (runs recorded before #1021), or an unexpected error.
- `2`: usage error.

It never exits 1. A reproduced failure is the finding, not a failure of the
command.

## Source

- [plan.ts](../../ts/src/analysis/rewind/plan.ts): fidelity table, repeat
  classification, nearest green.
- [runner.ts](../../ts/src/analysis/rewind/runner.ts): the replay command and
  reading the status back.
- [workspace.ts](../../ts/src/analysis/rewind/workspace.ts): git, install,
  predecessor files.
- [render.ts](../../ts/src/analysis/rewind/render.ts): text and `--json` output.
- [rewind-cli.ts](../../ts/src/rewind/rewind-cli.ts): orchestration and the
  command.
