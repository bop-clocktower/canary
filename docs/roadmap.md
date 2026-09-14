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

### Three test-design rules the port would have benefited from

- **Status:** backlog
- **Spec:** —
- **Summary:** Three mechanically-checkable rules, each drawn from a specific bug this cycle, sharing one theme — the tests exercised the shape the author was thinking about, not the shape a user hits. (1) Every CLI option with a fallback needs a test that OMITS the flag: #369 defaulted --diff to a bare `git diff`, empty on a clean CI checkout, and every test passed a diff explicitly, so the default path had zero coverage and the gate scoped zero paths across ~5 PRs. (2) Anything persistent needs a removal test: #456 proved a sentinel was written but never that it was cleared, so deleting the clearing half silently disabled Tier-2 authoring permanently. (3) Scale rules per the issue body.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#488

## Example Library

### Realworld-functions example library

- **Status:** backlog
- **Spec:** —
- **Summary:** Ongoing curated batches of real-world function examples with multi-framework test parity, used to exercise and demo canary's generation/analysis. Batches 1–9 shipped (latest: fifo-lot-consumer, luhn-card-validator — PR #279); further-batch ideation drafts live in docs/ideation/ (batch6's below-the-cut pool has two remaining, deliberately deferred as weaker candidates: truncate-grapheme [framework-parity risk], cron-next-fire [parsing-surface scope-creep risk] — next batch likely needs fresh ideation rather than this pool). Continue adding batches; numeric examples must pin integer/fractional input contracts (soundness S4) to stay sound. (refs: docs/ideation/realworld-function-batch*.md; docs/changes/realworld-functions-batch9/)
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#602

## Intake

### TestTracker ingest reporter (interim)

- **Status:** in-progress
- **Assignee:** <brianna.stevenski@example.com>
- **Spec:** docs/changes/testtracker-ingest-reporter/proposal.md
- **Summary:** Config-driven Playwright reporter shipped from `canary-test-cli` (`canary-test-cli/reporter`) that pushes runs to the TestTracker / QA Intelligence Dashboard ingest API. Consolidates the drifted per-repo `testtracker-reporter.ts` (consumer-a-api/web) into one versioned reporter; onboards Consumer B (consumer-b-api + consumer-b-web). INTERIM precursor to the spec-pure `canary publish` (see canary-internal unified-reporting spec), which is blocked on Phase 2a (`canary report`). Convergence + deprecation path documented in docs/wiki/TestTracker-Reporter.md.
- **Blockers:** publish/link canary-test-cli@5.15.0; dev TestTracker tenant+token (human).
- **Plan:** docs/changes/testtracker-ingest-reporter/plans/
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#603

### Flakiness detector skill over test-reporter history

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. A skill that ingests N canary-test-reporter run JSON artifacts and statistically flags flaky tests (pass/fail alternation) rather than diagnosing a single run. CORRECTED 2026-07-21 - THE STATED RISK WAS FACTUALLY WRONG WHEN WRITTEN. This entry claimed "historical run JSON is not persisted anywhere today" and scoped v1 to stateless caller-supplied artifacts on that basis. But `agent/history/` shipped 2026-06-10 (commit 72e884b), five weeks before this entry was authored, and already provides persistence (`canary history push`), queries (`flaky`/`timeline`/`summary`), AND flake-trend classification in agent/history/detector.py. Rescope: determine what detector.py does NOT yet cover (pass/fail alternation vs. trend classification) and wire a skill over the existing store rather than building a stateless v1. Effort likely LOWER than the original medium estimate. Suggested themed name: `canary-misfit` (teleports between pass and fail); naming only, no scope change. Next: gap analysis against detector.py, then /harness:brainstorming. (refs: docs/ideation/bop-themed-canary-skills-2026-07-21.md; agent/history/)
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#604

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

### canary-signal — QA impact digest

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 4 (score 6.75) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Broadcast a periodic digest of what testing actually caught - bugs prevented, sweeps run, escapes avoided - to Slack, Teams, or a PR comment, so the work of testing is visible to people who do not open the code. Serves STRATEGY.md track 5 (Quality made legible). CORRECTED 2026-07-21: the original entry blocked this on canary-clocktower on the belief that no run history is persisted. That belief was FALSE - `agent/history/` (shipped 2026-06-10, commit 72e884b) already provides a persisted store with `canary history push|flaky|timeline|summary`. This item is NOT blocked; it is a formatter/broadcaster over existing query output. Accepted risk to handle in spec: the digest must degrade honestly when history is thin - a digest reading "1 run, 0 escapes" UNDERSELLS QA and inverts the goal, so state the window size and sample count explicitly rather than implying a quiet week. Low effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#609

### canary-clocktower — run-history gap analysis (NOT a greenfield build)

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 5 (score 5.25) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. CORRECTED 2026-07-21 - THE ORIGINAL PREMISE WAS FALSE. The ideation claimed run artifacts "are stateless and ephemeral today" and framed this as a greenfield substrate. In fact `agent/history/` shipped 2026-06-10 (commit 72e884b) with schema.py, store.py (abstract + factory), local_store.py, supabase_store.py, detector.py (flake-trend classification), a `canary history` CLI (push/flaky/timeline/summary/migrate), and four unit-test files. The ideation was generated from roadmap/doc text that had itself drifted, and the false claim propagated into this entry. Rescope to a GAP ANALYSIS: what does canary-test-reporter NOT yet push into history, and which consumers (canary-signal, the flakiness item) are not yet wired to query it. Accepted risk to handle in spec: do not rebuild what exists - the deliverable is wiring plus a documented gap list, not a second store. Effort unknown until the gap analysis runs. Next: gap analysis, then /harness:brainstorming. DISAMBIGUATION 2026-08-07: Issue #340 was titled "Clocktower voices" and is NOT this row — it is a product-wide voice/report-theming concern, not a skill. It has been retitled off the clocktower name and has its own row below. Note also that the gap analysis here depends on Issue #538: nothing currently writes the local history store, so part of the gap may already be known.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#610

### canary-manhunter — release quality dossier

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 6 (score 5.25) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Assemble the full evidentiary case for a release - coverage tiers, guardian findings, sweep results, escape history - into one signed report aimed at client-success and delivery staff. Serves STRATEGY.md track 5 (Quality made legible). Accepted risk to handle in spec: reporting with no decision attached is theater and becomes a PDF nobody opens, the most common way quality tooling dies - the dossier must gate something real (a release checklist item) or answer a question someone is already asking under time pressure, or it should not be built. Medium effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#611

### canary-question — test-bug vs product-bug triage

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 8 (score 3.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Interrogate a failure and classify it as a false-fail (test defect) or a real SUT defect, showing its reasoning - the "is this a test bug or a real bug" question that currently costs triage time on every red build. Accepted risk to handle in spec: a wrong triage is WORSE than no triage - "it's just a flaky test" stamped on a genuine product bug is exactly how defects escape, and it would degrade the escaped-defect headline metric while appearing to help. Must never emit a confident verdict: fidelity-labeled hypothesis plus evidence, never a disposition. Medium effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#613

### canary-judomaster — incident to regression test

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 9 (score 3.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Turn a production failure (stack trace, repro, incident record) into a failing regression test that pins the defect - using the failure's own force. Directly serves the STRATEGY.md headline metric (escaped-defect ratio) by converting escapes into permanent coverage. Accepted risk to handle in spec: it needs structured incident input most orgs lack in machine-readable form (in practice you get a Slack thread and a screenshot), so it demos well then sits unused - ship a degraded path that accepts a pasted stack trace alone. Medium effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
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

### canary-shiva — predictive test ordering

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #460, and renamed from `canary-cassandra` on 2026-08-07 after the name collided with the vacuous-test-detection row above. Lady Shiva reads a fighter and anticipates the next move, which is the feature: mine the run-history NDJSON plus the PR diff to run likeliest-to-fail tests first, so on a multi-hour suite the failure surfaces in minute one rather than hour three. Accepted risk to handle in spec: ordering is an OPTIMIZATION, NEVER A FILTER — every test still runs, because a predictive ordering that silently drops tests is a correctness bug wearing a performance costume. Needs a defined cold-start fallback (diff-proximity, then declaration order; never fail) and an explicit did-it-help metric (time-to-first-failure vs the unordered baseline) or there is no way to know the model earns its complexity. Next: the blocking data spike in #460 — per-test pass/fail history, commit keying, retention, and whether any supported runner will accept an order.
- **Blockers:** Issue #538 (nothing writes the local history store, so the volume/retention question may already have a known answer)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#460

### canary-rewind — time-travel run debugging

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #461. Reconstruct a past run — env, seed, commit, order, traces — and replay a single failed test in that exact context, then diff against the nearest green run. The second of the two flagship bets that exploit the run-history asset. Accepted risk to handle in spec: "the exact context" is a claim the store must actually be able to honor; if seed and order were never recorded, replay reproduces a different run while presenting itself as the original, which is worse than not offering replay at all. The honest first deliverable may be a history-schema change. Note `rewind` is not a Birds of Prey name; if the roster convention is meant to hold, this row needs one.
- **Blockers:** Issue #538 (no writer for the local history store)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#461

### canary-misfit — E2E resilience injection

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #592. Wave 2. Wrap a Playwright run with route-level latency, 5xx bursts, aborted responses, and slow-network profiles, then report which flows degrade gracefully and which shatter. Injection sits at the Playwright route layer so it needs no application changes — the same property that makes canary-instrument additive-safe. Accepted risk to handle in spec: the output is a per-flow verdict, not a gate; a flow that shatters under a 5xx burst may be an accepted risk, and the deliverable is that someone decided. Needs a deterministic seed or a reported failure cannot be reproduced.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#592

### canary-mission-briefing — PR diff to human test charter

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #593. Wave 2. Given a diff, produce a plan for a person: what to verify manually, which edge cases the diff invites, which existing tests cover it and which parts nothing covers. Three skills read a diff and they are not interchangeable — canary-pr-guardian emits a gate verdict for CI, canary-generate-test emits code for the suite, and this one emits a charter for a human tester. It is explicitly not a gate and explicitly not generated code, and it is the only one of the three aimed at manual verification. Open in #593: whether the coverage half reuses the guardian's Tier-0 diff-coverage pass, and whether output is stdout Markdown or a sticky PR comment.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#593

### canary-sweep — site-wide a11y audit

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #594. Wave 2. Crawl routes, run axe-core per page, dedupe findings by component, and output a WCAG-mapped report with fix snippets. Component-level dedup is the load-bearing idea: a per-page axe dump already exists in a dozen tools and nobody reads it, and one bad button reported forty times is noise — noise is how a11y tooling gets muted. Accepted risk to handle in spec: route discovery is framework-specific, and a v1 that claims to discover routes while silently missing half is exactly the abstention failure this repo exists to prevent; taking an explicit route list is the honest version. Open in #594: whether this is in scope for a testing tool at all, or belongs downstream — it is the least test-shaped item in the Skill Forge batch.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#594

### canary-batwoman — post-merge closure verification

- **Status:** planned
- **Spec:** docs/changes/canary-batwoman/proposal.md
- **Summary:** Audits closed issues and reports, per file the closing PR changed, whether that artifact has actually EXECUTED since the merge. GitHub closes an issue on a `Closes #N` string match — a claim of completion with no denominator. Founding case is #749: fix merged, issue auto-closed, and the label-triggered workflow it repaired has not run since 2026-08-10, i.e. never with the fix in place. Deterministic, network-requiring (GitHub Actions run history), agent-free; advisory only — never blocks a job, never reopens an issue. Ships a probe registry so unassessable artifact types become countable NO PROBE rows rather than silence, and a summary line carrying one column per status so an abstention can never be folded into a pass. NAMING 2026-08-23: originally scoped as `canary-manhunter`; renamed because #611 already reserved that name for the release quality dossier and has the stronger claim on it (a prosecutor assembling a case file is what a dossier is). Same roadmap-vs-tracker minting collision recorded on the canary-cassandra row on 2026-08-07 — third occurrence, see #753's sibling discussion.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** —

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

## Engine and Platform

### Voice pack and themable external-report hooks

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #340, retitled 2026-08-07 off the "Clocktower voices" name that collided with the canary-clocktower row above. The project has a voice identity but it stops at one character in one file. Build out distinct voices for the Birds of Prey cast with a small style guide each, use them across session responses, report flavor lines, doc epigraphs, and CLI moments, and provide the engine-side hook for external-facing reports (a themable footer slot plus a clean way for overlays to inject brand styling into HTML output). Accepted risk to handle in spec: voice is garnish and never load-bearing — every voiced line carries the plain fact too, and a `--no-flavor` off-switch must exist for CI logs and formal contexts. Sequencing: voice attaches to a persona, so Issue #462 wants to land first or the pack ships unwired. New names must not collide with a shipped skill or an existing row — the failure this reconciliation just cleaned up; `cassandra` and `clocktower` are spoken for and `oracle` is retired and never reused.
- **Blockers:** Issue #462 (personas — voice needs something to attach to)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#340

### Shared company-knowledge schema and loader package

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #550. `.canary/company.json` — the org pointer file for Confluence spaces, Jira projects, internal domains, MCP servers, dashboards, and the user-catalog skill — is read by canary-ci-ready and canary-failure-impact, each with its own parsing. Extract the schema and loader into a shared, tool-neutral package so consumers stop re-deriving it and a schema change lands in one place. Enabler work: it unblocks nothing on its own but removes a duplicated contract that will drift.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#550

### Overlay workflow templates for consumer repos

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #459. `canary migrate`/`adopt` should install the overlay workflow templates into a consumer repo, shape-aware and using portable paths. Follows directly from the monorepo-shape work in Issue #504: once the tool knows a repo's shape it can install the right workflow rather than one template that assumes a single package at the root. Accepted risk to handle in spec: writing workflow files into someone else's repo is the highest-blast radius thing canary does, so it needs a dry-run plan shown before any write, matching the confirm-before-apply flow migrate already uses.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#459

### Measure abandonment, not satisfaction

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #491. Derive passive adoption signals from the analyses records — where users stop, which flows are started and never finished, which outputs are generated and never used — instead of asking whether people are satisfied. Serves the legibility track: abandonment is observable and honest where self-reported satisfaction is neither. Accepted risk to handle in spec: this is usage telemetry on real users, so what is collected, where it is stored, and how it is opted into all belong in the spec rather than the implementation, and nothing identifying may land in the records.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#491

### Pedagogical Reasoning Mode

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #342. A mode in which canary explains its reasoning as it works — why this framework, why this edge case matters, why this test is weak — so the tool teaches rather than only produces. Adjacent to the persona work in Issue #462: depth of explanation is one of the axes a persona definition would carry, and building this without personas risks hard-coding a second audience model beside the first. Accepted risk to handle in spec: explanation attached to a wrong answer is more convincing than the wrong answer alone, so this raises the cost of a confident-but-incorrect finding.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#342

## Product Surface Gaps
