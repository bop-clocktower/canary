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

## Idempotency

The run is idempotent on `(canary_run_id, suite)`. `canary_run_id` is
`GITHUB_RUN_ID` (plus `-GITHUB_RUN_ATTEMPT` when set), so retries within a CI run
dedupe and a manual re-run creates a distinct run. Outside CI it falls back to a
`<sha>-<uuid>` / `local-<uuid>` id.

## Sharded suites (merge-reports)

For sharded runs (e.g. the web-e2e nightly browser×shard matrix), do **not** run
the reporter per shard — that would push partial results. Instead push once from
the `merge-reports` step over the merged blobs:

```bash
npx playwright merge-reports --reporter "canary-test-cli/reporter" ./blob-report
```

with `TESTTRACKER_URL`, `TESTTRACKER_API_TOKEN`, and `TESTTRACKER_SUITE` set in
that step's environment. This yields exactly one run per suite per CI run.
