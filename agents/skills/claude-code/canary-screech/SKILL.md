---
name: canary-screech
description:
  Broken-main siren. Reads the cross-run history store, decides whether the
  default branch is red, and emits a one-page blast — culprit commit range,
  failure cluster, owning area, a quarantine-or-revert recommendation, and a
  chat-ready block — as a standalone markdown artifact plus a GitHub Actions
  `::error` annotation. Self-contained; emits only, never posts.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Screech

The **cross-run, branch-level** member of the failure-surfacing family:

| Skill                  | Scope                   | Knows the branch went red? |
| ---------------------- | ----------------------- | -------------------------- |
| `canary-fail-fast`     | in-run; aborts early    | no                         |
| `canary-test-reporter` | per-run summary         | no                         |
| **`canary-screech`**   | cross-run, branch-level | **yes**                    |

"The default branch is red" is not a fact any single run holds. It lives in the
sequence of runs, which is why this skill reads the run-history store rather
than a results file.

## Signal source

`test-results/reports/history-v2.jsonl` — the run-history store, one `RunRecord`
JSON object per line. No network, no credentials, no service, and no write
access to anything except the `--out` artifact path. A GH Actions webhook and a
polling loop were both considered and rejected: this family's contract is
deterministic and self-contained, and the store already carries `branch`,
`commit_sha`, `timestamp`, the pass/fail counts, and per-test `area` and
`failure_category`.

## What it emits

1. A standalone **markdown one-pager** (`--out`) with five sections: culprit
   commit range, failure cluster, owning area, recommendation, chat-ready block.
2. A single GitHub Actions **`::error` annotation**, so the break shows in the
   Checks UI rather than only in a file.

It emits the chat block. It does not post it — there is no Slack, Teams, or
webhook integration, by design.

## Recommendation

| Verdict       | When                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `revert`      | every failure sits in one owning area, attributable to one commit     |
| `quarantine`  | failures span several areas, or the culprit range is not attributable |
| `investigate` | the failures carry no `area` at all                                   |

`investigate` is deliberate: a confident recommendation derived from absent data
is worse than no recommendation.

## Abstention

A store with no run for the requested branch is a **zero denominator**. The
skill prints a loud `ABSTAINED` line and never the green copy — "main looks
fine" derived from zero observations is the false-green this repo keeps
re-learning. Under `--strict` that abstention exits `3`.

## Invocation

```bash
# Advisory (exit 0 whatever it finds) — the default:
canary skills run canary-screech -- --history test-results/reports/history-v2.jsonl

# Watch a non-default branch and write the artifact:
canary skills run canary-screech -- \
  --history test-results/reports/history-v2.jsonl \
  --branch release/7.x \
  --out test-results/reports/screech.md

# Gate a workflow on it:
canary skills run canary-screech -- \
  --history test-results/reports/history-v2.jsonl --strict

# Usage and the full flag list (exits 0):
canary skills run canary-screech -- --help
```

`--history` is required. `--branch` defaults to `main`.

### Exit codes

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| `0`  | advisory mode always; or `--strict` and green     |
| `1`  | `--strict` and the branch is red; or a read error |
| `2`  | usage error                                       |
| `3`  | `--strict` and the skill abstained                |

## CI wiring (GitHub Actions)

Run it on a schedule or after the default-branch test job, with `if: always()`
so a failed test step does not suppress the siren:

```yaml
- name: Broken-main siren
  if: always()
  run: |
    canary skills run canary-screech -- \
      --history test-results/reports/history-v2.jsonl \
      --out test-results/reports/screech.md \
      --strict
```
