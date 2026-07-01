---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-06-30T01:18:39.593Z
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->
<!-- Machine-managed by harness roadmap tooling: each feature field is a single
     line by schema contract, so the 80-column line-length rule does not apply.
     Completed work lives in docs/roadmap-archive.md (run: harness roadmap groom). -->

## Maintenance and Public Readiness

### Resolve roadmap api-signature doc drift

- **Status:** backlog
- **Spec:** —
- **Summary:** Harness entropy check reports ~60 `api-signature` doc-drift warnings concentrated in docs/roadmap.md — stale symbols from the oracle→canary rename and later refactors (e.g. `CanaryOrchestrator`, `GeminiProvider`/`google.genai`, `SelectorHealer`/`_attempt_selector_fix`, `SetupWizard`, `oracle__analyze_file`) plus likely false positives on classifier category strings (`e2e_ui`, `performance`, `accessibility`, …) and version tokens. Update genuinely stale refs; configure the detector to ignore known category enums/prose so they stop recurring. (refs: Issue #246)
- **Blockers:** —
- **Plan:** —

### Public-readiness de-identification

- **Status:** backlog
- **Spec:** —
- **Summary:** Before the repo is shown outside the maintainer's org (demo/portfolio/open-source), remove employer/client identifiers. Blockers: rename client-named `CompanyKnowledge` dataclass fields to generic names (e.g. `dashboard_url`/`dashboard_token_env`) across core/CLI/docs/tests; scrub the non-canonical committer email from git history via `git filter-repo --mailmap` (or add a `.mailmap`); genericize a client-specific token name in docs/guides/company-knowledge.md. Polish: add `pyproject.toml` license/authors metadata, reconcile README install path vs version badge, relocate internal planning/state docs, strip hardcoded local absolute paths. (refs: Issue #248)
- **Blockers:** —
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
