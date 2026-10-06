---
project: canary
version: 1
created: 2026-05-11
updated: 2026-08-02
last_synced: 2026-06-29
last_manual_edit: 2026-08-02T23:25:00.000Z
---

# Roadmap

<!-- markdownlint-disable-file MD013 -->
<!-- Machine-managed by harness roadmap tooling: each feature field is a single
     line by schema contract, so the 80-column line-length rule does not apply.
     Completed work lives in docs/roadmap-archive.md — move it there with
     `node scripts/roadmap-groom.mjs --apply`. There is no `harness roadmap
     groom`; this comment claimed one for months while ten done rows piled up
     here (#595). -->

## Maintenance and Public Readiness

## Example Library

### Realworld-functions example library

- **Status:** backlog
- **Spec:** —
- **Summary:** Ongoing curated batches of real-world function examples with multi-framework test parity, used to exercise and demo canary's generation/analysis. Batches 1–10 shipped (latest: topological-task-order, percentile-nearest-rank — batch 10, catalog now 21 examples: 10 pytest / 11 vitest); batch 6's below-the-cut pool is EXHAUSTED — its last two (truncate-grapheme [framework-parity risk], cron-next-fire [unbounded parsing surface]) are standing hard rejects, so every further batch needs fresh ideation, as batch 10 did. Continue adding batches; numeric examples must pin integer/fractional input contracts (soundness S4) to stay sound. (refs: docs/ideation/realworld-function-batch*.md; docs/changes/realworld-functions-batch10/)
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#602

## Intake

### TestTracker ingest reporter (interim)

- **Status:** in-progress
- **Assignee:** <brianna.stevenski@example.com>
- **Spec:** docs/changes/testtracker-ingest-reporter/proposal.md
- **Summary:** Config-driven Playwright reporter shipped from `canary-test-cli` (`canary-test-cli/reporter`) that pushes runs to the TestTracker / QA Intelligence Dashboard ingest API. Consolidates the drifted per-repo `testtracker-reporter.ts` (consumer-a-api/web) into one versioned reporter; onboards Consumer B (consumer-b-api + consumer-b-web). INTERIM precursor to the spec-pure `canary publish` (see canary-internal unified-reporting spec), which is blocked on Phase 2a (`canary report`). Convergence + deprecation path documented in docs/wiki/Ingest-Reporter.md.
- **Blockers:** none. The reporter is published and consumers push live runs; renamed to the ingest reporter (`CANARY_INGEST_*`) with #1148, #1149, #1150, #1176 and #1183 fixed (shard-aware run ids, timed_out/interrupted, collected + area, retry + preflight, clean titles + tags).
- **Plan:** docs/changes/testtracker-ingest-reporter/plans/
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#603

### Mutation-testing signal via Stryker

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 1.00, lowest / stretch) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Surface a mutation score (Stryker, already in the framework registry) as a coverage-quality signal - 'lines covered but assertions do not kill mutants'. Accepted risk / DEFERRED: Stryker per-PR is minutes-to-tens-of-minutes; without diff-scoped incremental mutation it is DOA in CI, and incremental mutation is itself hard. Revisit only if a diff-scoped mutation spike proves tractable. High effort / low confidence. Next: spike before /harness:brainstorming. LINKED 2026-08-07 to Issue #486, which is the diff-scoped proposal this deferral was waiting on and arrives with the evidence this row lacked (three vacuous tests that passed CI against the bug they were written to catch; two hand-run mutants decisive on #484). The row and the issue existed for weeks without either being reachable from the other. Also note Issue #339's canary-katana checkbox described this same work before that name shipped as deleted-test quarantine; #339 is now closed and #486 is the sole owner. Status stays backlog — the spike is still the next step, this is a link and not a decision.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#486

### canary-cry — pre-launch "try to break it" exploratory sweep

- **Status:** backlog
- **Spec:** —
- **Summary:** New skill (`agents/skills/claude-code/canary-cry/`, `/canary-cry`) for timeboxed adversarial exploration ahead of a launch, so a sales demo never has to explain away a bug. Targets real-world abuse of ordinary user flows rather than function-level inputs: impatient double/triple-submit of a CTA on a degraded network, back-button or force-close midway through a multi-form flow that already wrote partial rows, a second user on a shared machine signing out and signing up as themselves against stale session/cache/autofill state, plus duplicated-tab, token-expiry-mid-flow, and stale-optimistic-UI variants. Success criterion is state corruption ("platform left in a bad state"), not merely a rendering defect. Tiered execution: always emits a ranked scenario matrix (works with zero infra); when a live non-prod target plus credentials are supplied it additionally drives the app (Playwright MCP) and reports what actually broke, degrading loudly rather than silently skipping (per the #294/#295 fail-loud pattern). Timeboxed via an `--amplitude` dial where amplitude is how hard each flow is pushed and radius is how many flows are hit: `whisper` (narrow/shallow, ~30-60 min, routine major release) / `shout` (moderate, ~2-4 hrs, new-client onboarding) / `scream` (full radius, max depth, unbounded — initial launch and demo hardening). Composes rather than forks: canary-edge-case-discovery for case generation, canary-critical-areas + canary-failure-impact for radius ranking, canary-company-knowledge for org-specific flows and the user catalog, canary-test-reporter for output. Accepted risks to handle in spec: (1) `scream` against a live target is genuinely destructive — spammed CTAs and killed mid-write flows can corrupt shared data and fire real emails/payments/webhooks, so require an explicit non-prod target allowlist, refuse prod by default, and print a dry-run manifest before the first write; (2) an unbounded `scream` is a token and wall-clock bomb — needs convergence criteria (stop after K consecutive barren rounds) and resumable checkpoints rather than "explore until done"; (3) a finding without a deterministic repro is noise — every finding must carry replayable steps plus seed/state, or it cannot be triaged before the launch it was run for. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#608

### canary-judomaster — incident to regression test

- **Status:** planned
- **Spec:** docs/changes/614-canary-judomaster/proposal.md
- **Summary:** Ideation rank 9 (score 3.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Turn a production failure (stack trace, repro, incident record) into a failing regression test that pins the defect - using the failure's own force. Directly serves the STRATEGY.md headline metric (escaped-defect ratio) by converting escapes into permanent coverage. Accepted risk to handle in spec: it needs structured incident input most orgs lack in machine-readable form (in practice you get a Slack thread and a screenshot), so it demos well then sits unused - ship a degraded path that accepts a pasted stack trace alone. Medium effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** docs/changes/614-canary-judomaster/plans/2026-09-29-canary-judomaster-plan.md
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#614

### canary-ivy — suite overgrowth and pruning

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 10 (score 2.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Detect metastasized suites: duplicated fixtures, tests covering nothing not already covered, and runtime creep over time. PREMISE NEEDS RESHAPING BEFORE SPEC - the objection is severe enough to invalidate the current framing. Accepted risk to handle in spec: recommending test DELETION is the most dangerous advice a test tool can give, because a "redundant by coverage" test may be the only one asserting the behavior that breaks - line coverage does not capture assertion intent, and this directly contradicts canary's own target problem (coverage overlap is not equivalent proof). Reframe toward runtime/duplication reporting without deletion recommendations, or drop. Medium effort / medium confidence. Next: reshape premise, then /harness:brainstorming.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#615

### canary-harley — property-based and fuzz test generation

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 11 (score 2.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Generate property-based tests (fast-check, Hypothesis) with shrinking rather than example-based cases - input-level chaos, distinct from canary-cry's user-flow exploration and from canary-edge-case-discovery's reasoning about named cases. Accepted risk to handle in spec: property-based testing needs an INVARIANT, and articulating the invariant is the entire hard part - generating framework boilerplate around a weak or wrong property produces confident nonsense that shrinks to a meaningless minimal case. The real output should be a proposed invariant the human confirms, with codegen downstream of that confirmation. Medium effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#616

### canary-huntress — targeted regression pursuit

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 12 (score 2.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Hunt one specific defect CLASS across the entire suite and its history, rather than exploring broadly. First attempt to give the previously reserved canary-huntress name a scope; it did not clear the bar, so the name remains reserved. Accepted risk to handle in spec: git bisect already finds WHEN a regression entered and canary-cry explores broadly, so the remaining slice (find every OTHER place this same bug shape exists) may be too narrow to justify a skill rather than a flag on an existing one - this is a reserved name looking for a job, which is the wrong direction of fit. Medium effort / medium confidence. Next: find a genuinely distinct scope before speccing, or leave the name reserved.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#617

### canary-hawk-dove — gate threshold auto-tuner

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 13 (score 1.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Balance aggression against noise by tuning gate thresholds from the historical false-positive vs. escaped-defect record - the recurring "erodes trust" worry across the guardian items, solved with data instead of guesswork. Accepted risk to handle in spec: it requires ground-truth labels on past findings (was this finding real?) that nobody records, so without them it tunes on noise and produces a confidently wrong threshold - it is blocked behind both a history substrate and a labeling ritual humans will not reliably perform. High effort / low confidence; treat as a stretch item. Next: spike the labeling question before /harness:brainstorming.
- **Blockers:** no ground-truth outcome labels exist on past findings (the history store itself EXISTS - agent/history/, 2026-06-10 - so the substrate is not the blocker; the missing labels are)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#618

### canary-batgirl — developer and team quality scorecard

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 14 (score 1.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Streaks, badges, and rank derived from canary audit scores, recognizing sound and stable code. Serves STRATEGY.md track 5 (Quality made legible); the track legitimizes the goal but does not resolve the objection, which is why confidence stays low. Accepted risk to handle in spec - THE SHARPEST IN THE BATCH: Goodhart's law points this at canary itself. Scoring engineers on canary metrics makes them optimize the score, and the cheapest way to raise almost any coverage-derived score is to write more assertion-free tests - so a naive reward system would actively MANUFACTURE canary's own target problem. Safe only if it scores things that are expensive to fake (escaped-defect ratio, coverage-verified finding share) and never anything a developer can inflate by adding green. Medium effort / low confidence. Next: /harness:brainstorming to spec.
- **Blockers:** — (history substrate EXISTS: agent/history/, 2026-06-10; the Goodhart objection remains the real gate, not a missing store)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#619

### Audit evidence export — control-mapped evidence pack

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #855. Bundle what canary already produces as a byproduct — batwoman closure verification (the "proof, not assurance" re-test artifact), the katana deleted/skipped-test ledger, run history, ci-ready scores — into one time-windowed evidence pack with each item mapped to the control it supports (NIST SP 800-40 Rev. 4, ISO/IEC 27001:2022 A.8.8, CIS Control 7, SOC 2 CC7.1/CC8.1). JSON for GRC tooling plus a human-readable report. STRATEGY track 5 (quality made legible) aimed at auditors and procurement reviewers instead of engineers. Accepted risk to handle in spec: a control with zero backing evidence must render as NO EVIDENCE, never be omitted — an evidence pack that drops its empty rows is a false-green handed to an auditor. The mapping is an aid, not an attestation, and the report says so. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#855

### Load scenario composer — multi-population load with SLO thresholds

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #858. Compose several actor populations (public submitters, staff consoles, partner integrations, background jobs) into one run as parallel k6 scenarios, with SLOs as thresholds (p99 of a user-visible latency, not just error rate), attachable network-degradation profiles, and named templates (single large event, many concurrent events, upload flood, mass reconnect). Fills the gap between write-test's one-scenario-at-a-time generation and real surge load. Accepted risk to handle in spec: the traffic model is the deliverable — every population states the source of its numbers, and a threshold whose metric was never emitted fails as an abstention. Shares its degradation vocabulary with #592 (canary-misfit, route-layer injection); pairs with #856. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#858

### Canary QA site — versioned contract and embeddable site kit

- **Status:** planned
- **Spec:** docs/changes/canary-qa-site/proposal.md
- **Summary:** Issue #1151. Two-layer versioned QA data contract (`canary.run/1` per-run/per-test, `canary.assessment/1` per assessed metric) feeding a static `canary.site/1` feed; six framework-free embeddable panels; skills `canary-starling` (feed), `canary-barda` (standalone site), `canary-vixen` (embed). Abstention is a first-class value (null ≠ 0, absent ≠ empty), scope is always explicit, no composite health score. Dogfooded on the Vercel `canary` project via an Actions deploy (Git integration stays off per #787). Five phases, one PR each, merged serially; phase 2 absorbs reporter fixes #1148/#1149/#1150. Ideation: docs/ideation/a-qa-site-offered-as-an-add-on-2026-10-05.md (#1147).
- **Blockers:** phase 5 needs repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (human).
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1151

## Engine and Platform

## Product Surface Gaps
