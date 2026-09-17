---
name: canary-rewind
description: >
  Replays one failed test from run history at the commit it failed on, in a
  scratch worktree, and interprets what the replay can and cannot say. Use when
  asked "does this old failure still reproduce", "replay that failed run",
  "rewind run X", or "was this failure real or environmental". Reads the
  per-dimension fidelity table (restored / not-restored / not-recorded) so a
  replay is never mistaken for the original run. Advisory: never fixes,
  quarantines or files anything. NOT canary-flake-hunter (diagnoses a known
  flake), NOT canary-test-healer (fixes a consistent failure), NOT canary-savant
  (bisects order dependence).
cli: canary rewind
requires: [node>=20, git]
---

# Canary Rewind

A past failure is only evidence if you can tell how faithfully it was
reproduced. `canary rewind` reruns the failed test at its recorded commit and
reports every dimension of the original run as `restored`, `not-restored`, or
`not-recorded`. This skill reads that report and turns it into a conclusion the
evidence supports, and no stronger.

The CLI supplies the facts; this skill supplies the interpretation and the
hand-off.

## When to Use

- Someone points at a failed run in history and asks whether it still fails.
- A failure needs to be classed as code, environment, or intermittent before
  anyone spends time fixing it.
- A red run from days ago needs comparing against the last green one.

## When NOT to Use

- The test is already known to be flaky and needs diagnosing: use
  `canary-flake-hunter`.
- The test fails every time today and needs fixing: use `canary-test-healer`.
- You suspect another test pollutes this one: use `canary-savant`, which bisects
  order dependence. Rewind never claims order was restored.
- There is no history store, or the run was recorded as JUnit: rewind abstains.

## Usage

```bash
canary rewind --help
```

That needs no store and no network. A replay needs a run id and the exact test
name from the store (`canary history timeline "<name>"` lists runs of a test).

## Workflow

1. **Replay.** Run `canary rewind <run_id> --test "<name>" --json [--repeat N]`.
   Default repeat is 3; use 5 or more when the question is "flaky or not".
2. **Abstained (exit 3)?** Relay the `reason` verbatim and stop. Do not retry
   against a different commit, do not rerun the test on the current tree and
   call that a replay. Common reasons and the honest next step:
   - commit `local` or unreachable: the run cannot be replayed; say so.
   - test file not repo-relative: the run predates #1021; say so.
   - unsupported runner: only vitest and Playwright replay.
3. **Read the fidelity table before the outcome.** Every conclusion is bounded
   by it:
   - `environment: not-restored` means a differing Node/OS/arch or a failed
     install. A `not-reproduced` result under it cannot rule out an environment
     cause. Name the differing keys.
   - `seed: not-recorded` or `not-restored` means a shuffled suite may have run
     in a different order.
   - `order` is never `restored`. If the failure only happened in the full run,
     suggest `--with-predecessors`, then `canary-savant`.
   - `network`, `database` and `wall-clock` are always `not-restored`. A test
     that touches any of them can pass or fail for reasons the replay cannot
     see.
4. **State the outcome with its bound.**
   - `reproduced`: the failure is real at that commit, within the restored
     dimensions. Point at the nearest green run and its commit range as where to
     look.
   - `not-reproduced`: it did not fail here. Never say it "was flaky" or "is
     fixed". Say what differed (from the table) and that the original cause is
     unconfirmed.
   - `intermittent`: relay the hand-off line. Recommend `canary history flaky`
     for the rate and `canary-flake-hunter` for diagnosis. Rewind does not
     decide flakiness.
   - `not-run`: the test never ran; the environment row says why.
5. **Report** in this shape:

   ```text
   Rewind: <run_id> · <test> at <short sha>
   Outcome: reproduced (3 of 3), bounded by: environment restored,
            seed not-recorded, order not-restored
   Nearest green: <run_id>, <n> commit(s) back (<green sha>..<failing sha>)
   Next: <one concrete step>
   ```

## Rationalizations to reject

| Rationalization                                                   | Why it is wrong                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| "It passed on replay, so the original failure was flaky."         | Only `intermittent` is evidence of flakiness; `not-reproduced` is an absence.   |
| "The commit was unreachable, so I ran it on HEAD instead."        | That is a different run presented as the original, which rewind exists to stop. |
| "Environment is not-restored but close enough."                   | Name the differing keys; the reader decides what is close enough.               |
| "It reproduced, so the bug is in the nearest green commit range." | The range is where to look, not a verdict; network and time were not restored.  |

## Escalation

- Abstentions on every recent run (all `local` commits): the recording pipeline
  is not passing a commit; point at `canary history record --commit`.
- `not-run` from repeated install failures: report the lockfile install error;
  do not work around it.

## Related skills

- `canary-flake-hunter` — diagnose an intermittent failure.
- `canary-test-healer` — fix a consistent failure.
- `canary-savant` — order dependence and polluter bisection.
- `canary-fleet-health` — fleet-wide flake and regression summary.
- Guide: `docs/guides/rewind.md`
