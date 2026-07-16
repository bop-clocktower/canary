---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-07-15T23:10:50.065Z
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->
<!-- Machine-managed by harness roadmap tooling: each feature field is a single
     line by schema contract, so the 80-column line-length rule does not apply.
     Completed work lives in docs/roadmap-archive.md (run: harness roadmap groom). -->

## Maintenance and Public Readiness

### Resolve roadmap api-signature doc drift

- **Status:** blocked
- **Spec:** —
- **Summary:** BLOCKED on an upstream harness fix (Intense-Visions/harness-engineering#723). The api-signature drift detector floods this project with ~3.3k warnings that cannot be resolved project-side: it ignores the analyze.drift ignore/scope config in the entropy and CI paths, and mis-resolves Python symbols (it flags real, shipped fields as missing). Findings are non-blocking (warn severity) and concentrated in the historical roadmap archive, which must not be rewritten. Revisit when the upstream detector honors config and resolves Python symbols. (refs: Issue #246; upstream harness#723) [Note: symbol names intentionally omitted from this summary so the drift-tracking row does not itself register as drift.]
- **Blockers:** upstream harness#723 (api-signature detector)
- **Plan:** —

## Example Library

### Realworld-functions example library

- **Status:** backlog
- **Spec:** —
- **Summary:** Ongoing curated batches of real-world function examples with multi-framework test parity, used to exercise and demo canary's generation/analysis. Batches 1–7 shipped (latest: dense-rank-leaderboard, bytes-humanizer — PR #247); further-batch ideation drafts live in docs/ideation/. Continue adding batches; numeric examples must pin integer/fractional input contracts (soundness S4) to stay sound. (refs: docs/ideation/realworld-function-batch*.md)
- **Blockers:** —
- **Plan:** —

## Overlay Upstreaming

### Generic test reporter

- **Status:** done
- **Spec:** docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-test-reporter` at `agents/skills/claude-code/canary-test-reporter/`. Reads a Playwright JSON results file and emits a Markdown report (stdout or file via `--markdown-out`) and/or a JSON artifact (`--json-out`). Classifies all tests as passed/failed/flaky/skipped. Exits non-zero on any real failure; flakes do not affect exit code. Self-contained (bundles its own full-fidelity parser). Fully de-id'd. ~39 dedicated tests. JSON contract (`version: 1`) designed for future TCM integration. (refs: docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md)
- **Blockers:** —
- **Plan:** docs/superpowers/plans/2026-07-13-canary-test-reporter.md

### Fail-fast CI gate

- **Status:** done
- **Spec:** docs/changes/canary-fail-fast/proposal.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-fail-fast` at `agents/skills/claude-code/canary-fail-fast/`. Audits Playwright fail-fast config (`maxFailures`/`forbidOnly`/`retries`) and emits a categorized CI failure digest with GitHub `::error` annotations (non-zero exit on real failures; flakes excluded). Self-contained: bundles its own minimal Playwright JSON parser + failure categorizer (decoupled from the overlay's shared parser). Fully de-id'd (a test greps for residual client strings). 34 dedicated tests. (refs: docs/changes/canary-fail-fast/)
- **Blockers:** —
- **Plan:** docs/changes/canary-fail-fast/plans/2026-07-02-canary-fail-fast-plan.md

### OTel instrumentation bootstrap

- **Status:** done
- **Spec:** docs/changes/canary-instrument/proposal.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-instrument` at `agents/skills/claude-code/canary-instrument/`. Instruments a Playwright run with OpenTelemetry and emits a `run.json` v1 artifact correlating each test to the outbound HTTP requests it made, via OTel span parent/child relationships — no manual bookkeeping in test code. Trace-only v1 (Playwright/Node only; `coverage` block and `canary_run_id` cut, YAGNI); contract left additive-safe for future pytest/k6/node producers. Default file-based span export needs no OTel collector; opt-in OTLP via the existing `otel_exporter_endpoint` company-knowledge field. Fully de-id'd (dedicated test scans `.py/.md/.mjs/.ts`). 23 dedicated tests. Last item in the "Overlay Upstreaming" milestone — all three items now shipped. (refs: docs/changes/canary-instrument/, docs/adr/0006-otel-test-side-tracing.md, PR #265)
- **Blockers:** —
- **Plan:** docs/changes/canary-instrument/plans/2026-07-15-canary-instrument-plan.md
