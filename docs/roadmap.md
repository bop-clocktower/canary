---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-07-19T00:34:19.864Z
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
- **Summary:** PARTIALLY MITIGATED, still blocked on a narrower upstream gap. Original blocker (Intense-Visions/harness-engineering#723: analyze.drift config ignored + Python symbol mis-resolution) was fixed upstream via harness#724 and issue #246 closed 2026-07-15 after re-verification (roadmap.md's own residual findings dropped from ~60 to 6, non-blocking warn severity). Project-side, `entropy.analyze.drift.checkApiSignatures: false` was added to harness.config.json, verified via `harness cleanup --json` to fully suppress findings (1450 -> 0). However, `harness ci check` — what this repo's CI workflow actually runs — has its own separate, still-unfixed code path that does not honor this config at all (same config, 0 findings via cleanup vs. 1450 via ci check). That fourth call site is the new, narrower blocker. Findings remain non-blocking (warn severity) regardless. Revisit when the upstream fix lands. (refs: Issue #246 [closed]; Issue #266; upstream harness#838) [Note: symbol names intentionally omitted from this summary so the drift-tracking row does not itself register as drift.]
- **Blockers:** upstream harness#838 (`harness ci check` doesn't thread entropy.analyze.drift config)
- **Plan:** —

## Example Library

### Realworld-functions example library

- **Status:** backlog
- **Spec:** —
- **Summary:** Ongoing curated batches of real-world function examples with multi-framework test parity, used to exercise and demo canary's generation/analysis. Batches 1–9 shipped (latest: fifo-lot-consumer, luhn-card-validator — PR #279); further-batch ideation drafts live in docs/ideation/ (batch6's below-the-cut pool has two remaining, deliberately deferred as weaker candidates: truncate-grapheme [framework-parity risk], cron-next-fire [parsing-surface scope-creep risk] — next batch likely needs fresh ideation rather than this pool). Continue adding batches; numeric examples must pin integer/fractional input contracts (soundness S4) to stay sound. (refs: docs/ideation/realworld-function-batch*.md; docs/changes/realworld-functions-batch9/)
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
- **Summary:** DONE — shipped as the bundled executable skill `canary-fail-fast` at `agents/skills/claude-code/canary-fail-fast/`. Audits Playwright's own fail-fast config knobs (maxFailures, forbidOnly, retries — Playwright's field names, not Canary symbols) and emits a categorized CI failure digest with GitHub `::error` annotations (non-zero exit on real failures; flakes excluded). Self-contained: bundles its own minimal Playwright JSON parser + failure categorizer (decoupled from the overlay's shared parser). Fully de-id'd (a test greps for residual client strings). 34 dedicated tests. [Note: Playwright field names intentionally left unbackticked so the drift-tracking row does not itself register as drift.] (refs: docs/changes/canary-fail-fast/)
- **Blockers:** —
- **Plan:** docs/changes/canary-fail-fast/plans/2026-07-02-canary-fail-fast-plan.md

### OTel instrumentation bootstrap

- **Status:** done
- **Spec:** docs/changes/canary-instrument/proposal.md
- **Summary:** DONE — shipped as the bundled executable skill `canary-instrument` at `agents/skills/claude-code/canary-instrument/`. Instruments a Playwright run with OpenTelemetry and emits a `run.json` v1 artifact correlating each test to the outbound HTTP requests it made, via OTel span parent/child relationships — no manual bookkeeping in test code. Trace-only v1 (Playwright/Node only; a coverage block and a canary_run_id field were scoped out, YAGNI — never implemented, so neither exists in code today); contract left additive-safe for future pytest/k6/node producers. Default file-based span export needs no OTel collector; opt-in OTLP via the existing `otel_exporter_endpoint` company-knowledge field. Fully de-id'd (dedicated test scans `.py/.md/.mjs/.ts`). 23 dedicated tests. Last item in the "Overlay Upstreaming" milestone — all three items now shipped. [Note: the cut field names above are intentionally left unbackticked so the drift-tracking row does not itself register as drift.] (refs: docs/changes/canary-instrument/, docs/adr/0006-otel-test-side-tracing.md, PR #265)
- **Blockers:** —
- **Plan:** docs/changes/canary-instrument/plans/2026-07-15-canary-instrument-plan.md

## Intake

### canary-pr-guardian

- **Status:** planned
- **Spec:** docs/changes/canary-pr-guardian/proposal.md
- **Summary:** canary-pr-guardian — PR test-guardian skill
- **Blockers:** —
- **Plan:** —
