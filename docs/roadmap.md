---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-07-19T12:58:15.477Z
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

- **Status:** done
- **Spec:** docs/changes/canary-pr-guardian/proposal.md
- **Summary:** DONE (#312) — shipped as the PR test-guardian: a deterministic Tier-0 diff-coverage engine (`agent/guardian/pr_check.py` + `coverage.py`, CLI `canary guardian pr-check`) that posts fidelity-labeled findings (coverage-verified › graph-verified › heuristic) with no agent/secret/write-token, plus a PR surface (`.github/workflows/guardian.yml` + sticky comment), a pre-commit hook (`hooks/guardian_precommit.py`), an at-desk agent orchestrator (`agent/guardian/agent_tier.py` + `agents/skills/claude-code/canary-pr-guardian/` + `/canary-pr-guardian`), and harness-check emit (`agent/guardian/analysis_emit.py`, `--emit-analysis`). Gate defaults to soft; promote to hard per-repo once trust is earned. Capability boundary (SC-11): the Tier-0 engine imports no agent/LLM. Phases 1–6 all shipped. (refs: docs/changes/canary-pr-guardian/, docs/adr/0007-guardian-agent-capability-boundary.md, docs/adr/0008-guardian-canary-owned.md, docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** docs/changes/canary-pr-guardian/plans/

### Cobertura XML coverage parser for guardian

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation top pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Extend the guardian coverage-verified tier to parse Cobertura coverage.xml, which agent/guardian/coverage.py currently falls through on (unrecognized format -> drops to graph/heuristic tier). Broadens coverage-verified fidelity to Java/.NET/JS-Istanbul pipelines. Accepted risk to handle in spec: Cobertura is not one format (Jacoco vs Istanbul dialects differ in DTD/rate attrs) - pin to a named dialect and reject unrecognized shapes loudly rather than guess. Low effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Framework-registry depth audit + capability tiers

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. agent/frameworks/registry.json lists 21 frameworks but breadth exceeds depth; audit which have real generation/analysis support vs name-only and publish honest capability tiers so adopters do not hit a stub. Accepted risk to handle in spec: a point-in-time matrix rots - pair it with a coverage test that derives tiers from the registry rather than hand-maintained prose (drift-bait otherwise, ironic for canary). Low effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Coverage-json producer contract doc + validator

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Document + validate the canary coverage-json format that agent/guardian/coverage.py consumes, so third-party tools can emit canary-consumable coverage. Accepted risk to handle in spec: documenting today's accidental shape freezes its warts - do a minimal shape review first, frame as version:1 with additive-safe evolution (mirrors test-reporter/instrument contracts). Low effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Guardian hard-gate rollout automation

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 4.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Automate the soft->hard guardian gate flip: required-check registration + operator playbook (memory: hard-gate needs admin required-check registration). Accepted risk to handle in spec: branch-protection required-checks need admin scope and vary across GH Free/Team/Enterprise - detect plan/permission and fail loud with a manual-steps fallback rather than silently no-op (consistent with the fail-loud pattern from #294/#295). Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Wire quality_scorer into the guardian gate

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. agent/core/quality_scorer.py scores assertions/flakiness/magic-numbers but that signal is not consumed by the guardian gate, which only flags ABSENT tests, not WEAK ones (e.g. an added test that asserts nothing passes green). Accepted risk to handle in spec: a weak-test heuristic firing on legit table-driven/snapshot tests erodes trust - ship as advisory (non-blocking) fidelity-labeled finding first with a conservative high-precision threshold before any gate promotion. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Flakiness detector skill over test-reporter history

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. A skill that ingests N canary-test-reporter run JSON artifacts and statistically flags flaky tests (pass/fail alternation) rather than diagnosing a single run. Accepted risk to handle in spec: historical run JSON is not persisted anywhere today - scope v1 to consume a caller-supplied set of run artifacts (stateless) and defer any persistence/ingest tier; validates the analysis before investing in storage. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Generated-test soundness linter

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Reject generated tests that pin non-deterministic values or leave numeric input contracts unpinned (ties to realworld S4 integer/fractional soundness rule). Accepted risk to handle in spec: agent/core/static_linter.py and quality_scorer.py already exist - EXTEND them with the new rule in-place rather than adding a third overlapping half-enforcer. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Guardian coverage-delta (regression on touched units)

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Flag coverage REGRESSION on units a PR touches (vs base), not just absent coverage; reuse the existing agent/guardian/delta_emitter.py seam. Accepted risk to handle in spec: needs a base-branch coverage artifact most CI does not upload - degrade to 'delta unavailable - head-only' with a loud note when no base artifact is present. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Edge-case-discovery to generate-test handoff

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 2.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Wire canary-edge-case-discovery output directly into canary-generate-test input so users stop re-describing discovered cases by hand. Accepted risk to handle in spec: the separation may be intentional (discovery exploratory, generation committal) - wire as an explicit human-confirmed pass-through (discovery emits a structured artifact the user reviews before generation consumes it), not an automatic pipe. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Mutation-testing signal via Stryker

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 1.00, lowest / stretch) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Surface a mutation score (Stryker, already in the framework registry) as a coverage-quality signal - 'lines covered but assertions do not kill mutants'. Accepted risk / DEFERRED: Stryker per-PR is minutes-to-tens-of-minutes; without diff-scoped incremental mutation it is DOA in CI, and incremental mutation is itself hard. Revisit only if a diff-scoped mutation spike proves tractable. High effort / low confidence. Next: spike before /harness:brainstorming.
- **Blockers:** —
- **Plan:** —
