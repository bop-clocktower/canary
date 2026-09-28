---
name: canary-clocktower
description:
  Run-history gap analysis — reports, for the history store on disk, which of
  its consumers (canary-screech range and clusters, analyze common-failures,
  ci-ready runtime, flaky retry detection and area, order, rewind) are fed,
  partial, dark or unmeasured, per required field with denominators. Use when a
  history-backed report looks empty or one-bucket, after wiring `canary history
  record`, or when asking "what does our run history not carry". Read-only and
  deterministic; exits 0 fed, 1 gaps, 3 abstained on a missing or empty store.
  NOT a writer (it fills no field), NOT a remote-store analyser (local NDJSON
  only), and NOT a flake detector (`canary history flaky` is).
cli: canary history gaps
requires: [node>=20]
---

# Canary Clocktower

The run-history store has one writer and many readers. Each reader needs
particular fields, and a reader whose field no run carries does not fail — it
prints an empty table or a single `other` bucket, which reads like a quiet week.
Clocktower asks the store which readers it can actually feed.

## Why it exists

Issue #610 began as "build a run-history store". That premise was false: the
store and its writer already existed. The real gap was one level down. Three
test fields are declared in the history schema, read by consumers, and written
by no writer: `area`, `failure_category` and `tags`. Nothing measured that, so
nothing reported it.

## Usage

```bash
canary history gaps --help
```

Against the default store (`test-results/reports/history-v2.jsonl`), or another
one:

<!-- canary:illustrative -->

```bash
canary history gaps
canary history gaps --path test-results/reports/history-v2.jsonl --json
```

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Every measured consumer is fed.                                          |
| 1    | At least one consumer is dark or partial, or the store cannot be parsed. |
| 2    | Usage error.                                                             |
| 3    | Abstained: no store at the path, or a store with zero runs.              |

Zero runs is an abstention, never "no gaps". The output names the reason
(`store not found` or `store is empty`) and every consumer that went dark with
it.

## Reading the output

Each consumer lists its required fields as `carried/applicable`:

- `fed` — every applicable row carries every field.
- `partial` — some rows do.
- `dark` — no row carries at least one field.
- `unmeasured` — a field has no applicable rows (for example, no failed tests to
  carry a `failure_category`). It is listed as skipped, never counted as fed.

An opt-in consumer that is not fed names the `history record` flag that feeds it
and is listed as skipped, not as a finding.

`--json` lists every skipped entry under `skipped`. On an abstention it also
lists the consumers that went dark with the store under `darkByAbstention`.

A configured `CANARY_HISTORY_DB_URL` is named as a skipped remote store: the
command reads the local store only, and says so.

The consumer table, the status rule and the known gap list are in the
[History Gaps Guide](../../../../docs/guides/history-gaps.md).
