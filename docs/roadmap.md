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
- **Summary:** Issue #1151. Two-layer versioned QA data contract (`canary.run/1` per-run/per-test, `canary.assessment/1` per assessed metric) feeding a static `canary.site/1` feed; seven framework-free embeddable panels (a summary count row joined the original six in the visual pass); skills `canary-starling` (feed), `canary-barda` (standalone site), `canary-vixen` (embed). Abstention is a first-class value (null ≠ 0, absent ≠ empty), scope is always explicit, no composite health score. Dogfooded on the Vercel `canary` project via an Actions deploy (Git integration stays off per #787). Five phases, one PR each, merged serially; phase 2 landed the reporter's `canary.run/1` run file, `canary-starling` and ci-ready measures. Phase 3 landed the site kit (six panels, tokens, ADR 0036) and `canary-barda`. Ideation: docs/ideation/a-qa-site-offered-as-an-add-on-2026-10-05.md (#1147).
- **Blockers:** phase 5 needs repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (human).
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1151

### canary-blackalice — review a QA tool from the seats of the people who use it

- **Status:** planned
- **Spec:** docs/changes/canary-blackalice/proposal.md
- **Summary:** Issue #1524. A skill that reviews a QA tool from six personas' seats: manual tester, SDET, QA lead, developer, PM/owner, and external client viewer. It maps the tool's capabilities against a generic job catalog, plus an overlay that lives in the tool's own repo, then walks the 5–8 highest-risk jobs live. Every result surface is checked against Q1–Q4: plain language, loud states (failure, all-green and not-run each unmistakable), glance then drill-down, and trace and history for RCA. The output is a ledger-first `canary.tool-review/1` report (walked / mapped / not-assessed / not-applicable) with no composite score, and issues are filed only for the findings a human ticks. It has a deterministic, LLM-free core plus an agent layer. Four phases, one PR each, merged serially. Dogfoods first on the canary QA site's demo scope (row above), then on TestTracker, whose overlay and report stay in its own repo.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1524

### siren detects its own stale installed hook copy

- **Status:** backlog
- **Spec:** —
- **Summary:** install-siren copies hooks into ~/.claude/hooks, so merged siren fixes never reach a machine until someone reinstalls; the session siren should report its own divergence from the marketplace copy with a remedy that clears it, `--verify` must not print healthy over DIVERGENT lines, and the fc1112 provenance doc should say copies, not symlinks.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1632

### least-privilege permissions blocks for the remaining workflows

- **Status:** backlog
- **Spec:** —
- **Summary:** Four workflows (docs-lint, harness-quality, harness, validate-plugin) still declare no top-level `permissions:` block and rely on the repo's read default; add minimal blocks and generalise the workflow-hygiene test so every workflow must declare one.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1267

### canary dev-pipeline orchestrator for dev-time skills

- **Status:** backlog
- **Spec:** —
- **Summary:** Add an advisory dev pipeline that orchestrates the Canary skills useful while writing code (edge-case discovery, gap analysis), alongside the validation-shaped canary-test-pipeline and never acting as a gate.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#666

### voice pack overlay HTML brand-styling hook

- **Status:** backlog
- **Spec:** —
- **Summary:** Give overlays a clean way to inject brand styling into HTML output, split from #340, once an HTML report producer exists to consume the shipped `reportBranding()` hook.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1033

### craft backend absent reads as clean

- **Status:** backlog
- **Spec:** —
- **Summary:** craft-fleet is unconductable and security_craft abstains at 0 files because no craft backend has produced a run, yet both read as clean; surface the zero denominator as a failure instead of a pass.
- **Blockers:** upstream harness#2234
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1108

### judomaster structured intake adapters

- **Status:** backlog
- **Spec:** —
- **Summary:** Extend canary-judomaster beyond the pasted-stack-trace MVP with intake adapters for postmortem records, SARIF and pasted pen-test findings, plus the review follow-ups the MVP deferred.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1138

### cassandra import inference false-positive shapes

- **Status:** backlog
- **Spec:** —
- **Summary:** Cassandra's import inference misreports three shapes on canary's own suites (structural tests, a fixture used as a script handle, describe.each targets); teach it each shape so the remaining VAC-002/VAC-003 false positives clear.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1231

### cassandra VAC-001 stops flagging determinism tests

- **Status:** backlog
- **Spec:** —
- **Summary:** VAC-001 reports two independent calls with identical arguments as a self-comparison, so determinism and referential-identity tests read as vacuous; treat separate call evaluations as distinct values.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1233

### unset core.hooksPath is reported

- **Status:** backlog
- **Spec:** —
- **Summary:** A clone that skipped `git config core.hooksPath .githooks` runs a stale pre-commit copy or none, and nothing reports it; detect the unset hooks path and say so.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1240

### claude-code harness commands drift repaired

- **Status:** backlog
- **Spec:** —
- **Summary:** The generated `agents/commands/claude-code/harness/` commands drifted like the gemini-cli half fixed in #1249 (5 missing, mission-briefing hand-edited); regenerate them and guard the drift.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1269

### history migrate keeps colliding untimestamped runs

- **Status:** backlog
- **Spec:** —
- **Summary:** `canary history migrate` gives untimestamped v1 entries for one commit the same run_id, so the idempotent push drops one while the command still reports it migrated; derive distinct ids and report the true count.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1298

### PatternHealer reports correct lines and keeps blank lines

- **Status:** backlog
- **Spec:** —
- **Summary:** PatternHealer's whitespace groups cross newlines, so it reports a blank line as the change line and deletes or inserts blank lines around a healed call; anchor the groups to one line.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1310

### enumerateTests finds every test declaration

- **Status:** backlog
- **Spec:** —
- **Summary:** enumerateTests misses template-literal titles, `.only`/`.skip` modifiers and Python `async def` tests, so the previous test absorbs their bodies and assertions; recognise all three declarations.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1312

### static linter quoted triple-backtick no longer blanks code

- **Status:** backlog
- **Spec:** —
- **Summary:** `blankMultilineStrings` counts a quoted triple-backtick as a string delimiter and blanks the real code after it, silencing FLAKE-001, LINT-005 and FLAKE-003; track quote state when counting delimiters.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1313

### katana check mode for unledgered static skips

- **Status:** backlog
- **Spec:** —
- **Summary:** Add a katana check mode that fails when a static `test.skip`/`describe.skip` has no ledger row, so a test switched off without provenance no longer leaves CI green.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1319

### baseline ratchet mode for vacuity-check savant blackhawk

- **Status:** backlog
- **Spec:** —
- **Summary:** vacuity-check, savant and blackhawk run advisory forever and nothing notices when their finding counts grow; add a committed-baseline ratchet mode that fails on new findings.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1322

### quarantine for suites that are not test files

- **Status:** backlog
- **Spec:** —
- **Summary:** Katana's ledger and skip detectors assume a test is a function in a test file; support quarantining API collections, mobile flows and data-driven flows so those skips stop being invisible.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1323

### katana warns on a stale critical-areas.json

- **Status:** backlog
- **Spec:** —
- **Summary:** Katana degrades when critical-areas.json is missing but not when it is stale, so a months-old map reports 0 findings on reshaped areas; warn or abstain when the file is stale.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1325

### katana sees deleting an area's only executing test

- **Status:** backlog
- **Spec:** —
- **Summary:** Deleting the only test that executes a critical area reads as covered when other tests mock it through a barrel, and the saturation detector stays quiet; count only executing coverage.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1333

### queryFlaky keys tests by file

- **Status:** backlog
- **Spec:** —
- **Summary:** `queryFlaky` groups by test name only, so same-named tests in different files merge into a fabricated alternating flake; key the accumulator by file and name.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1350

### guardian sticky comment found for any token identity

- **Status:** backlog
- **Spec:** —
- **Summary:** Guardian's sticky comment is recognised only when posted as github-actions[bot], so any other token stacks a new copy every run; let the production path supply the posting identity.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1352

### testtracker push fails or chunks oversized payloads

- **Status:** backlog
- **Spec:** —
- **Summary:** A testtracker push over MAX_BODY_BYTES silently drops its catalog and still exits 0; fail or chunk the payload instead of degrading unseen.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1355

### requirement traceability from test to user story

- **Status:** backlog
- **Spec:** —
- **Summary:** Link tests to user stories and product-board items so a story marked ready for QA with no test, issue or PR behind it becomes visible.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1357

### Tier-0 scanners honour gitignore and survive large trees

- **Status:** backlog
- **Spec:** —
- **Summary:** savant, blackhawk and vacuity-check walk gitignored paths, so nested worktrees inflate counts about 27 times, and vacuity-check overflows the stack on a large subtree; skip ignored paths and walk iteratively.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1362

### cassandra VAC-003 accepts absence-is-the-behaviour guards

- **Status:** backlog
- **Spec:** —
- **Summary:** VAC-003's dominant false positive is a guard whose absence is the behaviour under test (0 of 30 sampled were vacuous by mutation); stop reporting those as absence-only.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1363

### cassandra VAC-003 counts throwing queries as observations

- **Status:** backlog
- **Spec:** —
- **Summary:** VAC-003 counts only `expect` calls, so a throwing `findBy*`/`getBy*` query or `.not.toBeNull()` is not seen as a positive observation; count them as presence checks.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1364

### cassandra VAC-002 subprocess and await-import blind spots

- **Status:** backlog
- **Spec:** —
- **Summary:** The two VAC-002 blind spots named in #705, child-process gate scripts and `(await import(x)).default` targets, still fire on 9.3.0; recognise both as touching the target.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1365

### cassandra VAC-002 recognises type-level tests

- **Status:** backlog
- **Spec:** —
- **Summary:** Type-level tests using `satisfies`, `expectTypeOf` or `import type` are reported as never touching their target; treat a referenced imported type as the target.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1366

### vacuity-check ignores phantom tests in comments

- **Status:** backlog
- **Spec:** —
- **Summary:** vacuity-check parses a phantom test out of a `//` comment such as `it ("Done"` and reports an unreproducible finding; skip comments when enumerating tests.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1367

### knowledge-pipeline reads ADRs with a folded title

- **Status:** backlog
- **Spec:** —
- **Summary:** `harness knowledge-pipeline` silently skips an ADR whose frontmatter `title:` prettier folded onto two lines, so the decision count stays flat with no warning; parse folded titles or report the skip.
- **Blockers:** upstream harness bug (knowledge-pipeline folded-title parse)
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1379

### mutation job closes its ADR 0038 gaps

- **Status:** backlog
- **Spec:** —
- **Summary:** The #486 mutation job still misses its spec where ADR 0038 records the gaps (no sticky comment section, no abstained report on crash, not diff-scoped, all-timeout runs); close each gap.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1380

### cassandra VAC-002 follows targets registered in setup helpers

- **Status:** backlog
- **Spec:** —
- **Summary:** A route registered in a beforeEach setup helper and driven through `app.inject` is reported as never touched; follow targets registered in setup into the test.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1388

### savant SV001 ignores declarations inside template literals

- **Status:** backlog
- **Spec:** —
- **Summary:** SV001 reports a declaration inside a template literal, the source of a child-process script, as a module-level mutable; skip template-literal contents.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1389

### savant SV004 ignores step-order comments inside one test

- **Status:** backlog
- **Spec:** —
- **Summary:** SV004 reports a comment narrating the order of steps inside a single test as cross-test order coupling; only flag names and comments that refer to other tests.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1390

### CHANGELOG Unreleased gate for user-facing PRs

- **Status:** backlog
- **Spec:** —
- **Summary:** Every release finds `[Unreleased]` missing most user-facing PRs and fills it by hand at cut time; add a gate so the gap shows up on the PR instead.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1418

### canary-unquarantine release step in the engine

- **Status:** backlog
- **Spec:** —
- **Summary:** Quarantine has a producer in the engine (katana's ledger) and no release step; add canary-unquarantine so a row is removed once its test passes live.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1455

### manhunter counts stale and unlinked quarantine rows

- **Status:** backlog
- **Spec:** —
- **Summary:** canary-manhunter's quarantine section does not yet count the stale, unlinked and unledgered rows the canary-unquarantine audit classifies; read the audit classes and count them.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1458

### guardian ingests npm coverage for npm diffs

- **Status:** backlog
- **Spec:** —
- **Summary:** The PR guardian reads only `ts/coverage/lcov.info`, so an `npm/` diff gets no coverage tier; upload and ingest `npm/coverage/lcov.info` too.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1464

### release publishes to next and promotes to latest

- **Status:** backlog
- **Spec:** —
- **Summary:** Build ADR 0044: publish every `v*` tag under `next`, promote stable tags to `latest` only after bin verification, and pin the npm upgrade step.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1477

### ci-ready flakiness drops deleted tests

- **Status:** backlog
- **Spec:** —
- **Summary:** ci-ready's flakiness check keeps scoring deleted tests until they age out of the history window, failing PRs that never touched them; score only tests that still exist.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1500

### CHANGELOG passes prettier check on main

- **Status:** backlog
- **Spec:** —
- **Summary:** CHANGELOG.md on main fails `prettier --check` at lines 39-41 of the siren entry; reflow the paragraph to prettier's 80-column wrap.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1502

### release Move latest tag tells a lost race from other push failures

- **Status:** backlog
- **Spec:** —
- **Summary:** The release workflow's Move latest tag step reports every rejected push, including auth and network failures, as a lost race; distinguish a real race from other failures.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1504

### ci-ready flakiness ignores quarantine releases and single retries

- **Status:** backlog
- **Spec:** —
- **Summary:** ci-ready counts quarantine releases and single retries as flips, so a history with zero failures scores red; stop counting those as flakiness.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1523

### katana follows registry-loaded files and renames

- **Status:** backlog
- **Spec:** —
- **Summary:** Katana falsely abstains on files tests load through a directory-scanned registry and counts renames as removals; follow registry loads and pair renames.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1528

### refresh-arch-baseline and workflow-hygiene follow-ups

- **Status:** backlog
- **Spec:** —
- **Summary:** Close the non-exploitable follow-ups from the #1537 security review, starting with refresh-arch-baseline spending the label opt-in when its push was skipped.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1540

### history record keeps an all-files-fail-to-load vitest run

- **Status:** backlog
- **Spec:** —
- **Summary:** `countVitestResults` counts only assertion results, so a vitest report where every file fails to load makes `canary history record` abstain and store nothing; record the load failures.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1551

### ticket-update five more misleading outcomes

- **Status:** backlog
- **Spec:** —
- **Summary:** Fix five more `canary ticket-update` outcomes that mislead, starting with a dry run that prints "Would post comment" and exits 0 for an unrecognised ticket key the real run rejects.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1552

### guardian lexer residual misreads

- **Status:** backlog
- **Spec:** —
- **Summary:** After the regex-aware `stripComments`, the guardian lexer still misreads a few shapes, including a regex read as division whose `/*` hides the lines after it; fix each residual case.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1553

### critical-areas score has one name

- **Status:** backlog
- **Spec:** —
- **Summary:** The mission briefing reads `rank_score` from critical-areas.json while every other consumer reads `risk_score`; settle on one field name across all readers.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1557

### katana reads the generated critical-areas.json by default

- **Status:** backlog
- **Spec:** —
- **Summary:** Katana has no default for `--critical-areas`, so the map `canary critical-areas` writes is ignored unless the flag is passed; default to `.canary/critical-areas.json`.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1558

### unquarantine settle commit built in a private index

- **Status:** backlog
- **Spec:** —
- **Summary:** `canary-unquarantine verdict --apply` checks out an untrusted PR branch and runs git in it with the operator's credentials; build the settle commit in a private index so the trial tree is never checked out.
- **Blockers:** redesign deferred by the human
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1560

### critical-areas landing follow-ups

- **Status:** backlog
- **Spec:** —
- **Summary:** Finish what #1550 landed without: the skipped soundness review, a re-run outcome_eval after the fixes, the docs-ratchet restamp and the other recorded gaps.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1564

### guardian type-only detector multi-line template and quadratic scan

- **Status:** backlog
- **Spec:** —
- **Summary:** The guardian's type-only detector keeps quote state per line, so a multi-line template can get runtime code proven type-only, and it is quadratic on empty statements; track quotes across lines and scan linearly.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1565

### guardian mutation report wording and crash handling

- **Status:** backlog
- **Spec:** —
- **Summary:** The guardian mutation report claims unmeasured coverage ("Tests covered these added lines") and a crash reads as surviving mutants; reword the claim and report a crash as a crash.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#1568

### site-kit typecheck turns on noImplicitAny

- **Status:** backlog
- **Spec:** —
- **Summary:** Turn on `noImplicitAny` for `tsconfig.site-kit.json` and JSDoc the kit to clear its 365 errors, most of them implicit-any parameters.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#1593

## Engine and Platform

## Product Surface Gaps
