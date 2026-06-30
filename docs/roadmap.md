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
