---
name: canary-instrument
description:
  Instrument a Playwright run with OpenTelemetry and emit a run.json
  artifact correlating every test to the outbound HTTP requests it made —
  "which test made which request?" — with zero manual bookkeeping in test
  code. Trace-only v1 contract, additive-safe for future pytest/k6/node
  producers. Self-contained (bundles its own dataclasses and span reader).
cli: scripts/cli.py
---

# Canary Instrument

Correlate every outbound HTTP request in a Playwright run to the test that
made it, using OTel span parent/child relationships. Zero required external
dependencies to produce output — default file-based span export, no OTel
collector needed.

## Setup (two manual steps, once per suite)

This skill ships fixture *files* you wire into your own suite — it does
not vendor OTel as a dependency of the `canary` package itself. Install
these first:

```bash
npm install --save-dev \
  @opentelemetry/sdk-node @opentelemetry/api \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

**1. Bootstrap the OTel SDK before Playwright starts** — add
`NODE_OPTIONS` to your test command (or `playwright.config.ts`'s
`webServer`/CI step):

```bash
NODE_OPTIONS="--import ./node_modules/canary/agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs" \
  npx playwright test
```

Copy `otel_bootstrap/instrument.mjs` into your repo (e.g.
`otel/instrument.mjs`) if you'd rather not reference the path inside
`node_modules`.

**2. Merge the root-span fixture into your `fixtures.ts`:**

```ts
import { test as base } from '@playwright/test';
import { withTestSpan } from './otel_bootstrap/playwright-fixture';

export const test = withTestSpan(base);
```

Every test using this `test` export now opens a root span carrying
`test.id`/`test.title`/`test.file`, and every HTTP call the test makes
nests under it automatically — no manual span code in individual tests.

## Invocation

```bash
canary skills run canary-instrument -- \
  --spans test-results/trace --output test-results \
  [--suite-type e2e_ui]
```

Writes `test-results/run.json`. Creates `--output` if it doesn't exist.
Missing/empty `--spans` produces `trace: {spans_total: 0, by_test: []}`,
not a failure. `--suite-type` is a free-form string (no enum) — pass
whatever label describes your suite.

## `run.json` v1 contract (trace-only)

```jsonc
{
  "schema_version": 1,
  "suite_type": "",
  "generated_at": "2026-07-15T18:00:00+00:00",
  "trace": {
    "spans_total": 124,
    "by_test": [
      {
        "test_id": "users-spec:1",   // "__setup__" for orphan traffic
        "test_title": "lists users",
        "test_file": "tests/users.spec.ts",
        "trace_id": "abc123...",
        "outcome": "passed",
        "requests": [
          { "method": "GET", "url": "http://localhost:3000/users/1",
            "route": "/users/:id", "status": 200, "duration_ms": 12.4,
            "span_id": "def456...", "started_at": "2026-07-15T18:00:01+00:00" }
        ]
      }
    ]
  }
}
```

No `coverage` key, no `canary_run_id` key — cut for v1 (see
`docs/adr/0006-otel-test-side-tracing.md` and
`docs/changes/canary-instrument/proposal.md`). Additive-only evolution: new
optional fields may appear later; existing fields never change meaning.

## Sending spans to a collector (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` before the test run and spans are
*additionally* streamed there — the file exporter still writes
`test-results/trace/otel-spans.*.jsonl` either way, so
`canary-instrument`'s own correlation is never dependent on a collector
being up. If your org's endpoint is recorded in company-knowledge, export
it first:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="$(canary company-knowledge show --json | jq -r '.otel_exporter_endpoint')"
```

See `docs/guides/company-knowledge.md` for the `otel_exporter_endpoint`
field.

## CI wiring (GitHub Actions)

```yaml
- name: Run Playwright (instrumented)
  env:
    NODE_OPTIONS: "--import ./otel/instrument.mjs"
  run: npx playwright test --reporter=json --output-file=test-results/results.json

- name: Correlate tests to HTTP spans
  if: always()
  run: |
    canary skills run canary-instrument -- \
      --spans test-results/trace --output test-results

- name: Upload run.json
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: run-trace
    path: test-results/run.json
```

## Related skills

- `canary-test-reporter` — Markdown/JSON test summary; `run.json`'s
  `by_test[]` rows are structurally similar to its `TestResult` shape
  (title/status as join keys) — a future consumer can read both artifacts
  with one join key.
- `canary-fail-fast` — aborts a broken run early; use alongside this skill
  for complete CI coverage.
