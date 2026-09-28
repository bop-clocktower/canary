# canary history gaps

Report which run-history consumers the store on disk actually feeds, field by
field, with denominators.

The run-history store (`test-results/reports/history-v2.jsonl`, written by
`canary history record`) has many readers: `analyze`, `ci-ready`, `order`,
`rewind`, canary-screech and `history flaky`. Each reads particular fields. A
reader whose field no run carries still runs, still prints a report, and is
still wrong: canary-screech over a store with no `area` recommends `investigate`
for every break, and `analyze common-failures` puts every failure in one `other`
bucket. `history gaps` (canary-clocktower, #610) names those readers.

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

`--json` carries the same facts as the text: `consumers` (each with its
`coverage`), `skipped` (every entry left out of the denominator, with its
reason), and, on an abstention, `reason` and `darkByAbstention` (the consumer
ids that went dark with the store).

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
failure-category consumer is unmeasured, not clean. When one requirement is
unmeasured, the whole consumer is unmeasured, even if another requirement is
dark.

Each denominator is the rows the named consumer reads. canary-screech counts a
test as failing only when it failed outright, so its `area` and
`failure_category` denominators leave flaky tests out. `failure-categories` and
`rewind` count failed and flaky tests.

An opt-in consumer that is not fed names the flag that feeds it, for example
`order-ttff: dark (fed only by history record --order-plan)`. It is listed as
skipped, not as a finding: not using the flag is a choice, not a writer defect.

## Consumers

| id                   | Surface                                | Requires (denominator)                                                                                            |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `screech-range`      | canary-screech culprit range, timeline | `branch`, `commit_sha`, `timestamp` (runs)                                                                        |
| `screech-cluster`    | canary-screech owning area, clusters   | `area`, `failure_category` (failed tests, flakes excluded)                                                        |
| `ci-ready-runtime`   | `canary ci-ready` suite runtime        | `duration_ms` greater than 0 (runs)                                                                               |
| `flaky-retry`        | `history flaky`, `analyze flaky`       | `reporter_format` Playwright or JUnit (runs)                                                                      |
| `flaky-area`         | `history flaky` area column            | `area` (tests)                                                                                                    |
| `failure-categories` | `analyze common-failures`              | `error_text`, `failure_category` (failed tests)                                                                   |
| `order`              | `canary order`                         | `test_file`, `duration_ms` (tests)                                                                                |
| `rewind`             | `canary rewind`                        | `commit_sha` not `local`, `reporter_format` Vitest or Playwright (runs); repo-relative `test_file` (failed tests) |
| `order-ttff`         | `canary order --report`                | `order` (runs), opt-in `--order-plan`                                                                             |

The `rewind` row lists the fields whose absence makes rewind refuse to replay.
`replay` and `start_index` only change how faithful a replay is: without them
rewind still runs and reports the seed or file order as not restored. They are
not requirements here.

`analyze area-health` is not in the table. Its engine never computes a row
(`analysis/engine.ts` hard-codes an empty set), so it is dark whatever the store
carries, and no field a writer fills can change that. `analyze spikes` is not in
the table either: it counts failure rates, not categories, so no gap here
affects it.

## Known gaps (2026-09-28)

What `history gaps` reports on a store written by today's `history record`:

| ID  | Gap                                                                              | Disposition                                                   |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| G1  | `area` is declared and read (screech, `history flaky`), but no reader writes it. | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G2  | `failure_category` is declared and read, but never written.                      | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G3  | `tags` is declared and pushed, but never written.                                | [#1125](https://github.com/bop-clocktower/canary/issues/1125) |
| G4  | canary-test-reporter did not say that `history record` persists the same report. | fixed in #610                                                 |
| G5  | canary-signal is not on `main`, so it cannot be wired yet.                       | add a consumer row                                            |
| G6  | The Vitest reader cannot emit `flaky`, so `flaky-retry` is dark for Vitest-only. | known (#604), surfaced                                        |
| G7  | `analyze area-health` computes no rows, whatever the store carries.              | structural, not a field gap                                   |
| G8  | The Playwright reader keeps `error_text` for failures but not for flakes.        | surfaced as `failure-categories` partial `error_text`         |

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
