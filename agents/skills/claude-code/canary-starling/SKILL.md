---
name: canary-starling
description:
  QA site feed composer. Composes a validated canary.site/1 feed from the
  run-history store, canary.run/1 run files, the katana quarantine ledger and a
  `canary ci-ready --json` report. An absent input becomes a not-assessed
  assessment naming what is missing, never an omitted row and never a zero. A
  feed that fails validation is never written; a feed with zero runs abstains.
  Writes only, never deploys.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Starling

A QA page that reads "0 flaky, all suites green" over a feed that carried no
runs says the opposite of the truth. `canary-starling` composes the one
`site.json` the canary QA site loads, validates it against the
[`canary.site/1`](../../../../docs/specs/canary-site-feed-contract.md) contract
before writing it, and names every input it could not use.

## What this is not

- **Not a deployer.** No hosting, upload, credentials or network. It writes one
  file to `--out`; publishing it is the site workflow's job.
- **Not a metric engine.** Starling owns no metric math. Every assessment value
  is the `measure` a `canary ci-ready --json` check already carries; a check
  that measured nothing stays `not-assessed` with that check's own reason.
- **Not a scope guesser.** Scope (`id`, `env`) comes only from
  `canary-site.config.json`. Without it, starling refuses (exit 1).

## Invocation

```bash
canary skills run canary-starling -- \
  --config canary-site.config.json \
  --history test-results/reports/history-v2.jsonl \
  --ci-ready ci-ready.json --out site/site.json

# Add canary.run/1 files (from the reporter's runFile) or canary.assessment/1
# files as positional RECORD arguments:
canary skills run canary-starling -- \
  --config canary-site.config.json --out site/site.json \
  test-results/run-s1of2.json test-results/run-s2of2.json

# Usage and the full flag list (exits 0):
canary skills run canary-starling -- --help
```

| Flag         | Default                   | Meaning                                                    |
| ------------ | ------------------------- | ---------------------------------------------------------- |
| `--config`   | required                  | `canary-site.config.json`: scope and declared suites       |
| `--out`      | required                  | where `site.json` is written (only when it validates)      |
| `--history`  | —                         | run-history JSONL store                                    |
| `--ledger`   | `.canary/quarantine.json` | katana ledger; default missing = dark, explicit = exit 1   |
| `--ci-ready` | —                         | a `canary ci-ready --json` report                          |
| `--strict`   | off                       | exit 3 when the feed carries zero runs                     |
| `RECORD ...` | —                         | `canary.run/1` / `canary.assessment/1` files, each checked |

## `canary-site.config.json`

```json
{
  "scope": { "id": "canary", "env": "ci" },
  "suites": ["ts-engine", "e2e"]
}
```

`scope.id` and `scope.env` are required. Omit `suites` and the feed says "none
declared" (`suites: null`); an empty list declares zero suites.

## What goes into the feed

- **Runs**: history rows and RECORD run files, the newest 30 per
  `(scope, suite)`. Per-test `results` ride only on each suite's newest run.
- **Flaky tests**: each test counted once, with `flaky_runs` over the
  `window_runs` that carried per-test results.
- **Assessments**: the five ci-ready metrics (`coverage-depth`, `flakiness`,
  `assertion-quality`, `critical-paths`, `suite-runtime`), plus any RECORD
  assessment files, keeping only the latest `observed_at` per
  `scope.id + scope.env + source + metric`.
- **Register**: katana ledger rows, with no author.

## Honest degradation

- **Left-out history rows**: a row with no ISO timestamp, no `duration_ms`, or a
  test outside passed/failed/flaky/skipped (or with an absolute path) is left
  out and named on stderr, never given an invented value.
- **Dark ledger**: the default ledger path missing is named on stderr; ledger
  rows with no date, commit or reason are left out and named.
- **Not-assessed metrics**: with no `--ci-ready`, or a check that skipped or
  measured nothing, each metric is a `not-assessed` assessment whose `reason`
  names the missing input.
- **Zero runs**: `ABSTAINED` on stdout; the feed is still written, and exits 3
  under `--strict`.
- **Invalid input**: a RECORD file that is not a valid run or assessment record,
  or a composed feed that fails validation, is printed error by error and
  nothing is written.

## Exit codes

`0` written · `1` read error or invalid feed · `2` usage · `3` under `--strict`
when the feed carries zero runs.
