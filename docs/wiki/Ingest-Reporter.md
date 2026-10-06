# Ingest Reporter

A config-driven Playwright reporter shipped from `canary-test-cli` that pushes a
completed run to a QA dashboard's `/api/ingest` endpoint. One reporter,
versioned with Canary, replacing the per-repo reporter copies consumers used to
keep.

> **Renamed.** This was the "TestTracker reporter". The import path
> (`canary-test-cli/reporter`) is unchanged. The old `TESTTRACKER_*` env vars
> still work for one release and print a one-line deprecation notice; rename
> them to the `CANARY_INGEST_*` names below.
>
> **Interim.** This reporter is the precursor to the spec-pure `canary publish`
> command (see [Convergence](#convergence)). Adopt it now; expect to migrate to
> `canary publish` once `canary report` (unified-reporting Phase 2a) ships.

## Requirements

- `canary-test-cli@>=5.15.0` in the repo's devDependencies.
- `@playwright/test >=1.40.0` (already present in any Playwright suite; it is an
  **optional** peer dependency of `canary-test-cli`).

## Usage

Add the reporter to your `playwright.config.ts`, alongside your existing
reporters:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['canary-test-cli/reporter', { suite: 'consumer-b-api' }],
  ],
});
```

### Options

| Option           | Env fallback                     | Legacy env (deprecated)        | Default        | Purpose                                                                |
| ---------------- | -------------------------------- | ------------------------------ | -------------- | ---------------------------------------------------------------------- |
| `suite`          | `CANARY_INGEST_SUITE`            | `TESTTRACKER_SUITE`            | — (required)   | Suite name on the dashboard (e.g. `consumer-b-api`, `consumer-a-web`). |
| `testFilePrefix` | `CANARY_INGEST_TEST_FILE_PREFIX` | `TESTTRACKER_TEST_FILE_PREFIX` | `<cwd>/`       | Prefix stripped from absolute test file paths.                         |
| `environment`    | `CANARY_INGEST_ENVIRONMENT`      | `TESTTRACKER_ENVIRONMENT`      | (unset)        | Environment label (`stage`, `uat`, `prod`, …).                         |
| `url`            | `CANARY_INGEST_URL`              | `TESTTRACKER_URL`              | (unset)        | Dashboard base URL; the reporter posts to `<url>/api/ingest/runs`.     |
| `token`          | `CANARY_INGEST_TOKEN`            | `TESTTRACKER_API_TOKEN`        | (unset)        | Ingest token (scope `ingest:runs`).                                    |
| `workflow`       | `CANARY_INGEST_WORKFLOW`         | `TESTTRACKER_WORKFLOW`         | `playwright`   | Free-form workflow label.                                              |
| `areaMap`        | `CANARY_INGEST_AREA_MAP` (JSON)  | —                              | `{}`           | Glob → product area, first match wins. See [Areas](#areas).            |
| `retryDelaysMs`  | —                                | —                              | `[1000, 4000]` | Waits before each retry of a 5xx, 429 or network error.                |
| `titleFormat`    | `CANARY_INGEST_TITLE_FORMAT`     | —                              | `legacy`       | `legacy` or `clean`. See [Title format](#title-format).                |

When both a `CANARY_INGEST_*` var and its legacy name are set, the new name
wins.

### Areas

A test's product area comes from, in order:

1. an `area` annotation:
   `test('redeem', { annotation: { type: 'area', description: 'rewards' } }, …)`;
2. the first `areaMap` glob matching its repo-relative file:
   `{ 'tests/**/rewards/**': 'rewards' }` (`**` crosses directories, `*` stays
   within one).

A test matching neither sends **no** area. The reporter never guesses one from a
folder name, so `functional` or `smoke` never shows up as a product area.

### Environment variables

Set these in CI (GitHub Actions secrets):

```text
CANARY_INGEST_URL=https://<your-dashboard-deployment>
CANARY_INGEST_TOKEN=<token>               # per-tenant, scope ingest:runs
```

### Title format

`full_title` is the dashboard's test identity: quarantine entries and flake
history key on it.

- `legacy` (default):
  `chromium > tests/functional/foo.spec.ts > @functional foo > does x @functional`
  — project, file, describe chain and title, exactly as before.
- `clean`: `foo > does x` — describe chain and title only, with inline `@tag`
  tokens removed (they are already in `tags`). The project moves to a
  `project:<name>` tag, so a 3-browser suite reports each test **once**, with
  the worst status across browsers and every browser in its tags. If two
  different files hold a test with the same clean title, those titles keep a
  file prefix (`tests/x.spec.ts > foo > does x`) so they are never merged.

**Switching to `clean` changes every test's identity**, which starts fresh
history and orphans existing quarantine entries. Coordinate with the dashboard
(re-keying history) before turning it on; the default stays `legacy` (#1183).

### Tags the reporter adds

On top of the test's own Playwright tags (sent once each, without the `@`):

| Tag              | When                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `project:<name>` | Always: the Playwright project the test ran in.                                          |
| `setup`          | The project is another project's `dependencies` target. Filter it out of test counts.    |
| `teardown`       | The project is another project's `teardown`.                                             |
| `fixme`          | The test is `test.fixme`.                                                                |
| `reason:<text>`  | A `fixme`/`skip` annotation has a description, often an issue ref (capped at 100 chars). |
| `interrupted`    | The test was interrupted (see [Status semantics](#status-semantics)).                    |

## What it sends besides results

- **`collected`** — every test Playwright collected, whether or not it ran
  (`full_title`, `test_file`, `tags`, `area`). It is the denominator that lets
  the dashboard tell "not covered" from "did not run" (#1150). An empty suite
  sends `collected: []`, a real measured zero. A **shard** push omits it,
  because one shard's tests are not the suite; push from `merge-reports` to get
  a catalog for a sharded suite. If the dashboard's `collected_count` differs
  from what was sent, the reporter prints a warning.
- **Preflight** — before the tests run, the reporter calls
  `GET <url>/api/ingest/whoami` and logs the tenant the token writes to. A
  `401`/`403` is reported straight away and the run is not pushed. An
  unreachable endpoint, or a dashboard without `/whoami`, does not block the
  push.
- **Retry** — a `5xx`, `429` or network error is retried (3 attempts in all,
  honouring `Retry-After` up to 30 s). Ingest is idempotent, so a retry cannot
  double-count. A `4xx` is a payload problem and is not retried. A run that is
  not ingested ends with a warning (and a GitHub Actions annotation), never a
  quiet log line.

## When it pushes (and when it doesn't)

- Pushes **only** when `url` + `token` are set **and** running in CI (`CI=true`
  / `GITHUB_ACTIONS=true`) — **or** when you force it locally with
  `CANARY_INGEST_PUSH=true`.
- Missing config, or local runs without the force flag → the reporter **no-ops
  silently**. It never fails a test run: a config or network error is logged (as
  a warning when the run was meant to be pushed) and swallowed.

## Status semantics

| Playwright status | Sent as     | Notes                                                                                                                                                                                                                                         |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`          | `passed`    |                                                                                                                                                                                                                                               |
| `failed`          | `failed`    |                                                                                                                                                                                                                                               |
| `timedOut`        | `timed_out` | Counted in `totals.failed` (the ingest totals have no timed-out bucket).                                                                                                                                                                      |
| `interrupted`     | `failed`    | Tagged `interrupted`, error prefixed `interrupted:`. The ingest API has no interrupted status, and `skipped` would drop the test out of the pass-rate denominator and make a cut-short run look clean (#1149). The run itself is `cancelled`. |
| `skipped`         | `skipped`   |                                                                                                                                                                                                                                               |

### Flaky

Per-test status uses Playwright's `test.outcome()`, not the per-attempt
`result.status` (which is never `flaky`). So a test that **failed then passed on
retry** is reported as `flaky` — visible to SDETs in the per-test results, with
the first failing attempt's error preserved so they can see _why_ it flaked.

At the **run** level a recovered flake is **not** counted as a failure: with no
hard failures, the run status is `flaky` (never `failed`). Clients / management
reading the top line see a non-failing run; the flaky count is the SDET signal.
(If a deployment prefers the run headline to read a flat `passed` when only
flakes occurred, that is a dashboard display choice, not a reporter change.)

## Idempotency

The run is idempotent on the **composite** `(canary_run_id, suite)` (server
arbiter index `(tenant_id, canary_run_id, suite)`). `canary_run_id` is
`GITHUB_RUN_ID` (plus `-GITHUB_RUN_ATTEMPT` when set), so retries within a CI
run dedupe and a manual re-run creates a distinct run. Outside CI it falls back
to a `<sha>-<uuid>` / `local-<uuid>` id.

When Playwright runs a shard (`--shard=2/4`), the shard is appended:
`42-1-s2of4`. Before this, every shard of one workflow run sent the same
`canary_run_id`, so the first shard to push won and every later shard was
answered `duplicate: true` with its results silently discarded (#1148).

`canary_run_id` intentionally does **not** include the suite — the suite is
already part of the dedup key, so different suites in the same workflow run
(`consumer-b-api` + `consumer-b-web`, both `run_id=42`) are distinct records.
The corollary: do not push the **same** suite from several matrix legs that are
not Playwright shards (for example one leg per browser with `--project`), or
they collide on the composite key.

A `duplicate: true` response is logged as a plain re-push only when the stored
run holds as many results as this push sent. If the counts differ, the reporter
prints a warning (and a GitHub Actions `::warning` annotation) saying this
push's results were discarded.

## Sharded suites (merge-reports)

Push once from the `merge-reports` step over the merged blobs:

```bash
npx playwright merge-reports --reporter "canary-test-cli/reporter" ./blob-report
```

with `CANARY_INGEST_URL`, `CANARY_INGEST_TOKEN`, and `CANARY_INGEST_SUITE` set
in that step's environment. This yields exactly one run per suite per CI run.
The run's `started_at`/`finished_at` come from Playwright's merged result, so
they describe the original test run, not the few hundred milliseconds the merge
step takes (#1176).

Pushing from each shard also works now (each shard lands as its own run,
`…-s1of4`, `…-s2of4`), but the dashboard then shows a sharded suite as several
partial runs. `merge-reports` remains the recommended setup.

## Convergence

This reporter is the **interim** delivery. The canonical design (see the
`unified-reporting.md` spec in `canary-internal`) is a `canary publish` command
that binds to the frozen `test-report.json` envelope produced by `canary report`
(unified-reporting **Phase 2a**). That "QA dashboard live integration" is a
roadmap item **blocked on Phase 2a**, which has not shipped yet.

Migration path once `canary publish` lands:

1. Replace `["canary-test-cli/reporter", …]` in `playwright.config.ts` with a
   post-run CI step: `canary report` → `canary publish`.
2. This reporter is deprecated for one minor release (kept for migration), then
   removed.

**Impedance mismatch the successor must resolve:** the ingest API wants
**per-test rows** (`full_title`, `test_file`, per-test status/tags/area); the
frozen `test-report.json` is **aggregate-first** (summary + area_health +
failures + quarantined). `canary publish` must either extend the envelope with a
per-test array or push from raw Playwright JSON. This interim reporter sidesteps
the issue by reading Playwright's own `onTestEnd` per-test data directly.
