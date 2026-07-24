# TestTracker Ingest Reporter

A config-driven Playwright reporter shipped from `canary-test-cli` that pushes a
completed run to the TestTracker (QA Intelligence Dashboard) ingest API. One
reporter, versioned with Canary — replaces per-repo copies of
`testtracker-reporter.ts`.

> **Interim.** This reporter is the precursor to the spec-pure `canary publish`
> command (see [Convergence](#convergence)). Adopt it now; expect to migrate to
> `canary publish` once `canary report` (unified-reporting Phase 2a) ships.

## Requirements

- `canary-test-cli@>=5.15.0` in the repo's devDependencies.
- `@playwright/test >=1.40.0` (already present in any Playwright suite; it is an
  **optional** peer dependency of `canary-test-cli`).

## Usage

Add the reporter to your `playwright.config.ts`, alongside your existing reporters:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["canary-test-cli/reporter", { suite: "capwell-api" }],
  ],
});
```

### Options

| Option           | Env fallback                    | Default        | Purpose                                                        |
| ---------------- | ------------------------------- | -------------- | -------------------------------------------------------------- |
| `suite`          | `TESTTRACKER_SUITE`             | — (required)   | Suite name on the dashboard (e.g. `capwell-api`, `optum-web`). |
| `testFilePrefix` | `TESTTRACKER_TEST_FILE_PREFIX`  | `<cwd>/`       | Prefix stripped from absolute test file paths.                 |
| `environment`    | `TESTTRACKER_ENVIRONMENT`       | (unset)        | Environment label (`stage`, `uat`, `prod`, …).                 |
| `url`            | `TESTTRACKER_URL`               | (unset)        | TestTracker base URL.                                          |
| `token`          | `TESTTRACKER_API_TOKEN`         | (unset)        | Ingest token (`tt_…`, scope `ingest:runs`).                    |
| `workflow`       | `TESTTRACKER_WORKFLOW`          | `playwright`   | Free-form workflow label.                                      |

### Environment variables

Set these in CI (GitHub Actions secrets):

```
TESTTRACKER_URL=https://<your-testtracker-deployment>
TESTTRACKER_API_TOKEN=tt_xxxxxxxx        # per-tenant, scope ingest:runs
```

## When it pushes (and when it doesn't)

- Pushes **only** when `url` + `token` are set **and** running in CI
  (`CI=true` / `GITHUB_ACTIONS=true`) — **or** when you force it locally with
  `TESTTRACKER_PUSH=true`.
- Missing config, or local runs without the force flag → the reporter **no-ops
  silently**. It never fails a test run: a config or network error is logged as a
  single line and swallowed.

## Status semantics (flaky)

Per-test status uses Playwright's `test.outcome()`, not the per-attempt
`result.status` (which is never `flaky`). So a test that **failed then passed on
retry** is reported as `flaky` — visible to SDETs in the per-test results, with
the first failing attempt's error preserved so they can see *why* it flaked.

At the **run** level a recovered flake is **not** counted as a failure: with no
hard failures, the run status is `flaky` (never `failed`). Clients / management
reading the top line see a non-failing run; the flaky count is the SDET signal.
(If a deployment prefers the run headline to read a flat `passed` when only
flakes occurred, that is a TestTracker display choice, not a reporter change.)

## Idempotency

The run is idempotent on the **composite** `(canary_run_id, suite)` (server
arbiter index `(tenant_id, canary_run_id, suite)`). `canary_run_id` is
`GITHUB_RUN_ID` (plus `-GITHUB_RUN_ATTEMPT` when set), so retries within a CI run
dedupe and a manual re-run creates a distinct run. Outside CI it falls back to a
`<sha>-<uuid>` / `local-<uuid>` id.

`canary_run_id` intentionally does **not** include the suite — the suite is
already part of the dedup key, so different suites in the same workflow run
(`capwell-api` + `capwell-web`, both `run_id=42`) are distinct records. The
corollary: do not push the **same** suite from multiple matrix legs of one
workflow run, or they collide on the composite key — push once per suite (for
sharded suites, at the `merge-reports` step below).

## Sharded suites (merge-reports)

For sharded runs (e.g. the web-e2e nightly browser×shard matrix), do **not** run
the reporter per shard — that would push partial results. Instead push once from
the `merge-reports` step over the merged blobs:

```bash
npx playwright merge-reports --reporter "canary-test-cli/reporter" ./blob-report
```

with `TESTTRACKER_URL`, `TESTTRACKER_API_TOKEN`, and `TESTTRACKER_SUITE` set in
that step's environment. This yields exactly one run per suite per CI run.

## Convergence

This reporter is the **interim** delivery. The canonical design (see the
`unified-reporting.md` spec in `canary-capillary`) is a `canary publish` command
that binds to the frozen `test-report.json` envelope produced by `canary report`
(unified-reporting **Phase 2a**). That "QA Intelligence Dashboard live
integration" is a roadmap item **blocked on Phase 2a**, which has not shipped yet.

Migration path once `canary publish` lands:

1. Replace `["canary-test-cli/reporter", …]` in `playwright.config.ts` with a
   post-run CI step: `canary report` → `canary publish`.
2. This reporter is deprecated for one minor release (kept for migration), then
   removed.

**Impedance mismatch the successor must resolve:** the ingest API wants **per-test
rows** (`full_title`, `test_file`, per-test status/tags/area); the frozen
`test-report.json` is **aggregate-first** (summary + area_health + failures +
quarantined). `canary publish` must either extend the envelope with a per-test
array or push from raw Playwright JSON. This interim reporter sidesteps the issue
by reading Playwright's own `onTestEnd` per-test data directly.
