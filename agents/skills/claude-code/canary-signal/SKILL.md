---
name: canary-signal
description:
  QA impact digest. Reads the run-history store and the katana quarantine ledger
  and emits a markdown digest plus a chat-ready block of what testing caught in
  a window -- failures caught on branches other than main, failures that reached
  main, flaky tests surfaced, and the quarantine trail. Every number is printed
  beside its denominator; a metric whose denominator is zero abstains, a window
  with no runs abstains, and a window with one or two runs carries a THIN SAMPLE
  banner. Emits only, never posts.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Signal

A digest reading "1 run, 0 escapes" says "QA did nothing this week". That
undersells the work and inverts the point of a digest. `canary-signal` states
its sample before it states anything else, and it declines to print a number it
did not measure.

## What this is not

- **Not a broadcaster.** No Slack, Teams, webhook, PR comment, credentials or
  network. It writes markdown to stdout and, with `--out`, to one file. Pipe the
  chat block wherever you like.
- **Not a scheduler.** The digest is a pure function of its inputs; a cron
  workflow can call it (below).
- **Not a claim that bugs were prevented.** A failure on a feature branch is
  reported as exactly that. A failing test can be a test bug.

## Invocation

```bash
# Last 7 days to now, default ledger (.canary/quarantine.json):
canary skills run canary-signal -- \
  --history test-results/reports/history-v2.jsonl

# A reproducible past week, written to disk:
canary skills run canary-signal -- \
  --history test-results/reports/history-v2.jsonl \
  --until 2026-09-28T00:00:00Z --days 7 --out reports/signal.md
```

| Flag        | Default                   | Meaning                                                  |
| ----------- | ------------------------- | -------------------------------------------------------- |
| `--history` | required                  | run-history JSONL store; missing = exit 1                |
| `--ledger`  | `.canary/quarantine.json` | katana ledger; default missing = dark, explicit = exit 1 |
| `--branch`  | `main`                    | the default branch                                       |
| `--days`    | `7`                       | window length                                            |
| `--until`   | now                       | window end, ISO-8601                                     |
| `--out`     | —                         | also write the markdown here                             |
| `--strict`  | off                       | exit 3 when the digest abstained                         |

## What it measures

| Line                         | Denominator (abstains at 0)                            |
| ---------------------------- | ------------------------------------------------------ |
| Tests executed               | runs in the window                                     |
| Failures caught off `main`   | runs on other branches                                 |
| Failures that reached `main` | runs on `main`                                         |
| Flaky tests surfaced         | runs from a flaky-capable reporter (playwright, junit) |
| Quarantine trail             | ledger present and non-empty                           |
| Production escapes           | never measured -- always a dark source                 |

Runs with no parseable timestamp, and runs with no branch, are counted and
named, never silently dropped.

## Honest degradation

- **0 runs in the window**: `ABSTAINED`. No "What testing caught" section.
- **1–2 runs**: a `THIN SAMPLE` banner stating the count.
- **Dark sources**: every source that could not be read is named with the
  reason. Production escapes are always listed, because no canary store records
  them.

## Exit codes

`0` advisory (always, without `--strict`) · `1` a source could not be read or
`--out` could not be written · `2` usage · `3` abstained, under `--strict` only.

## Scheduling it

The digest reads a store; it does not create one. Run it wherever the
run-history store already lives -- typically as a step after the suite has
recorded its run (`canary history record`), or on a schedule against a store
restored from a cache or artifact. A fresh checkout with no store exits `1`
(`history store not found`), never a quiet digest.

```yaml
- name: QA impact digest
  if: always()
  run: |
    canary skills run canary-signal -- \
      --history test-results/reports/history-v2.jsonl \
      --out test-results/reports/signal.md
```

Post the chat-ready block from the artifact with whatever your team already
uses; this skill never posts it.
