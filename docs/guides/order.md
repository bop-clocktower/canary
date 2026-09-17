# canary order

Order a suite's test files so the ones likeliest to fail run first, from run
history and the diff. Ordering is an optimization, never a filter: every file
you pass in comes back exactly once.

This is phase 2 of #460
([proposal](../changes/460-predictive-test-ordering/proposal.md)). A runner
adapter that applies the plan comes next; until then the plan is advisory
output.

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
