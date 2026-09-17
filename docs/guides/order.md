# canary order

Order a suite's test files so the ones likeliest to fail run first, from run
history and the diff. Ordering is an optimization, never a filter: every file
you pass in comes back exactly once.

This is #460 ([proposal](../changes/460-predictive-test-ordering/proposal.md)).
Vitest applies a plan through the sequencer below; for other runners the plan is
advisory output.

## Usage

```bash
canary order --suite ts-engine test/a.test.ts test/b.test.ts
git ls-files 'test/*.test.ts' | canary order --suite ts-engine --files-from -
canary order --suite ts-engine --files-from files.txt --base origin/main
canary order --suite ts-engine --files-from files.txt --json --out plan.json
```

- `--suite` must match the suite name used with `canary history record`.
- File paths may be relative to the current directory; they are stored
  repo-relative, the same key history uses
  ([ADR 0029](../knowledge/decisions/0029-repo-relative-test-file-history-join-key.md)).
- `--base` diffs `<base>...HEAD`. Without it there is no diff term.
- `--path` / `--db-url` pick the history store. A backend that cannot return
  whole runs is noted and its history is not used.

## Applying a plan in vitest

```ts
// vitest.config.ts
import CanaryOrderSequencer from 'canary-test-cli/vitest-sequencer';

export default defineConfig({
  test: { sequence: { sequencer: CanaryOrderSequencer } },
});
```

```bash
canary order --suite unit --files-from files.txt --base origin/main --out plan.json
CANARY_ORDER_PLAN=plan.json npx vitest run
```

- Without `CANARY_ORDER_PLAN`, or with a plan it cannot read, the sequencer uses
  vitest's own order (and says so on stderr for an unreadable plan).
- Files the plan does not name run last. No file is ever dropped: on canary's
  own suite an ordered and an unordered run both reported 4793 tests in 234
  files.
- Vitest runs files in parallel, so the plan orders scheduling, not strict
  execution. On that same run the six ranked files started at positions 0-28 of
  234, against 8-192 unordered.
- `canary-test-cli` must be installed in the project (vitest is resolved from
  there), and vitest 5 or later is required. pytest and Playwright have no
  adapter yet.

## Did it help?

Record runs with the plan, then ask:

```bash
canary history record vitest.json --suite unit --order-plan plan.json
canary order --report --suite unit        # add --json for the machine shape
```

`record --order-plan` stores the plan's `mode` and two time-to-first-failure
estimates on the run: in plan order and in the declaration order the plan was
built from. Both are recorded per-test durations summed serially up to the first
failing test, so they compare two orders of one run rather than measure wall
clock. A run with no failure stores `null` for both.

The report takes the first 20 runs that had a failure, compares the median
ordered estimate with the median baseline, and prints the full denominator: runs
recorded with a plan, measurable, not measurable. The verdict is `insufficient`
until 20 measurable runs exist, then `lower` or `not-lower`. It is advisory and
always exits 0.

Canary's own `fleet-health` job runs its suite in plan order and prints this
report on every run.

## How files are scored

The score is additive and each term is printed as a reason next to the file:

| Term            | Weight                                          | Reason text                  |
| --------------- | ----------------------------------------------- | ---------------------------- |
| Failure history | each failed run in the last 20 counts `0.9^age` | `failed 3 of last 20 runs`   |
| File changed    | 1                                               | `changed in diff`            |
| Imports changed | 0.5                                             | `imports src/x.ts (changed)` |

Import proximity comes from `.canary/test-inventory.json` (`canary inventory`).
Without an inventory only "the file itself changed" counts.

Ties go to the faster file (mean recorded duration), then to the path, so the
same inputs always produce the same order. Files with no signal are `unranked`:
they keep their declaration order after the ranked ones and carry no reasons.

The weights are starting values, to be tuned once the "did it help" metric has
evidence (#460 criterion 7).

## Modes

The plan always states its mode and why:

| Mode           | When                                        |
| -------------- | ------------------------------------------- |
| `history+diff` | the suite has at least 5 recorded runs      |
| `diff-only`    | fewer than 5 runs, and a `--base` was given |
| `declaration`  | fewer than 5 runs and no diff: input order  |

A cold-start order never passes itself off as a learned one: `modeReason` names
the run count, for example `2 of 5 runs needed for history`.

## Exit codes

- `0`: a plan was emitted, in any mode.
- `2`: unreadable `--files-from`, a `--base` that does not resolve, or a plan
  that is not a permutation of its input (a bug; nothing is emitted).
- `3`: abstained because no test files were given. An empty plan is not an
  order.

## Source

- [rank.ts](../../ts/src/analysis/order/rank.ts): scoring, modes and the
  permutation check.
- [order-cli.ts](../../ts/src/order/order-cli.ts): inputs and the command.
- [apply.ts](../../ts/src/analysis/order/apply.ts): applying a plan to a file
  list.
- [vitest-sequencer.ts](../../ts/src/analysis/order/vitest-sequencer.ts): the
  vitest adapter.
- [order-ttff.ts](../../ts/src/history/keys/order-ttff.ts): the TTFF estimates
  `record --order-plan` stores.
- [ttff-report.ts](../../ts/src/analysis/order/ttff-report.ts): the did-it-help
  report.
- Skill: [canary-shiva](../../agents/skills/claude-code/canary-shiva/SKILL.md)
