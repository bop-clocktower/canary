---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-06-30T21:46:10.196Z
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

- **Status:** backlog
- **Spec:** —
- **Summary:** Generalize the private overlay's test-reporter skill into a client-agnostic upstream reporter: Playwright JSON results → Markdown/JSON/self-contained HTML report + Slack summary + per-branch run history + `@known-failure` quarantine ledger. No upstream equivalent exists — highest-leverage of the three. De-id before adopting: give it a neutral `canary-` name, make result/output paths and the quarantine tag configurable (current values as defaults), make the Slack webhook optional, drop downstream-consumer references. Effort: medium (~15 scripts). (refs: private overlay test-reporter skill; companion run-summary skill)
- **Blockers:** —
- **Plan:** —

### Fail-fast CI gate

- **Status:** backlog
- **Spec:** —
- **Summary:** Generalize the private overlay's fail-fast skill: audit Playwright fail-fast config (`maxFailures`/`forbidOnly`/`retries`) and emit a categorized CI failure digest with GitHub `::error` annotations. Cleanest candidate — zero client strings; de-id is a neutral rename plus making the results path configurable and decoupling the shared results parser. Effort: low. (refs: private overlay fail-fast skill)
- **Blockers:** —
- **Plan:** —

### OTel instrumentation bootstrap

- **Status:** backlog
- **Spec:** —
- **Summary:** Generalize the private overlay's instrumentation skill: ship ready-made OpenTelemetry instrumentation fixtures for playwright/pytest/k6/node plus a `run.json` contract correlating tests → HTTP spans. Matches a known upstream gap (no OTel bootstrap exists). De-id: neutral rename; make the exporter endpoint generic config (`.canary/company.json → otel_exporter_endpoint`); untangle or make optional the dependency on the coverage engine. Effort: medium. (refs: private overlay instrumentation skill)
- **Blockers:** —
- **Plan:** —
