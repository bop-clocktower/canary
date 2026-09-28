# canary history gaps

Report which run-history consumers the store on disk actually feeds, field by
field, with denominators.

The run-history store (`test-results/reports/history-v2.jsonl`, written by
`canary history record`) has many readers: `analyze`, `ci-ready`, `order`,
`rewind`, canary-screech and `history flaky`. Each reads particular fields. A
reader whose field no run carries still runs, still prints a report, and is
still wrong: `analyze area-health` over a store with no `area` is an empty
table, and every failure-category report is one `other` bucket. `history gaps`
(canary-clocktower, #610) names those readers.

## Usage

```bash
canary history gaps --help
```

<!-- canary:illustrative -->

```bash
canary history gaps --path test-results/reports/history-v2.jsonl --json
```

`--path` defaults to `test-results/reports/history-v2.jsonl`. The command reads
the local NDJSON store only. When `CANARY_HISTORY_DB_URL` is set, the remote
store is named as skipped in the summary line, never silently ignored.

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Every measured consumer is fed.                                            |
| 1    | At least one consumer is dark or partial, or the store cannot be parsed.   |
| 2    | Usage error.                                                               |
| 3    | Abstained: the store does not exist, or exists with zero runs. Not a pass. |

A missing store and an empty store are both abstentions, with different reasons:
`store not found: <path>` and `store is empty: <path> (0 runs)`. The store
reader returns nothing for both, so the command checks existence itself — a
typo'd path must read as a typo'd path.

## Statuses

Each consumer lists its required fields as `carried/applicable`:

| Status       | Rule                                                          |
| ------------ | ------------------------------------------------------------- |
| `fed`        | Every applicable row carries every required field.            |
| `partial`    | Some rows carry each field, but not all.                      |
| `dark`       | No row carries at least one required field.                   |
| `unmeasured` | A required field has no applicable rows. Rendered as skipped. |

`unmeasured` is never `fed`. `failure_category` only means something on a failed
or flaky test, so a store with no failures has no denominator for it: the
failure-category consumer is unmeasured, not clean.

An opt-in consumer that is dark names the flag that feeds it — for example
`order-ttff: dark (fed only by history record --order-plan)`.

## Consumers

| id                   | Surface                                | Requires (denominator)                       |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| `screech`            | canary-screech, `history timeline`     | `branch`, `commit_sha`, `timestamp` (runs)   |
| `ci-ready-runtime`   | `canary ci-ready` suite runtime        | `duration_ms` (runs)                         |
| `flaky-retry`        | `history flaky`, `analyze flaky`       | `reporter_format` Playwright or JUnit (runs) |
| `area-health`        | `analyze area-health`, flaky area col. | `area` (tests)                               |
| `failure-categories` | `analyze spikes` / `common-failures`   | `failure_category` (failed tests)            |
| `order`              | `canary order`                         | `test_file`, `duration_ms` (tests)           |
| `rewind`             | `canary rewind`                        | `replay` (runs), `start_index` (tests)       |
| `order-ttff`         | `canary order --report`                | `order` (runs), opt-in `--order-plan`        |

## Known gaps (2026-09-28)

What `history gaps` reports on a store written by today's `history record`:

| ID  | Gap                                                                              | Disposition                                                   |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| G1  | `area` is declared and read, but no format reader writes it.                     | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G2  | `failure_category` is declared and read, but never written.                      | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G3  | `tags` is declared and pushed, but never written.                                | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G4  | canary-test-reporter did not say that `history record` persists the same report. | fixed in #610                                                 |
| G5  | canary-signal is not on `main`, so it cannot be wired yet.                       | add a consumer row                                            |
| G6  | The Vitest reader cannot emit `flaky`, so `flaky-retry` is dark for Vitest-only. | known (#604), surfaced                                        |

The full analysis and its design decisions are in the
[proposal](../changes/610-canary-clocktower/proposal.md).

## Source

- [consumers.ts](../../ts/src/analysis/clocktower/consumers.ts) — the consumer
  table; the one place to update when a consumer or writer changes.
- [gaps.ts](../../ts/src/analysis/clocktower/gaps.ts) — per-requirement coverage
  and the status rule.
- [render.ts](../../ts/src/analysis/clocktower/render.ts) — text output.
- [cli.ts](../../ts/src/analysis/clocktower/cli.ts) — the command and its exit
  contract, mounted from the engine registry.
