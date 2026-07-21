---
project: canary
version: 1
created: 2026-05-11
updated: 2026-06-29
last_synced: 2026-06-29
last_manual_edit: 2026-07-21T21:28:28.000Z
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
- **Summary:** PARTIALLY MITIGATED, still blocked on a narrower upstream gap.
  Original blocker (Intense-Visions/harness-engineering#723: analyze.drift
  config ignored + Python symbol mis-resolution) was fixed upstream via
  harness#724 and issue #246 closed 2026-07-15 after re-verification
  (roadmap.md's own residual findings dropped from ~60 to 6, non-blocking warn
  severity). Project-side, `entropy.analyze.drift.checkApiSignatures: false` was
  added to harness.config.json, verified via `harness cleanup --json` to fully
  suppress findings (1450 -> 0). However, `harness ci check` — what this repo's
  CI workflow actually runs — has its own separate, still-unfixed code path that
  does not honor this config at all (same config, 0 findings via cleanup vs.
  1450 via ci check). That fourth call site is the new, narrower blocker.
  Findings remain non-blocking (warn severity) regardless. Revisit when the
  upstream fix lands. (refs: Issue #246 [closed]; Issue #266; upstream
  harness#838) [Note: symbol names intentionally omitted from this summary so
  the drift-tracking row does not itself register as drift.]
- **Blockers:** upstream harness#838 (`harness ci check` doesn't thread
  entropy.analyze.drift config)
- **Plan:** —

## Example Library

### Realworld-functions example library

- **Status:** backlog
- **Spec:** —
- **Summary:** Ongoing curated batches of real-world function examples with
  multi-framework test parity, used to exercise and demo canary's
  generation/analysis. Batches 1–9 shipped (latest: fifo-lot-consumer,
  luhn-card-validator — PR #279); further-batch ideation drafts live in
  docs/ideation/ (batch6's below-the-cut pool has two remaining, deliberately
  deferred as weaker candidates: truncate-grapheme [framework-parity risk],
  cron-next-fire [parsing-surface scope-creep risk] — next batch likely needs
  fresh ideation rather than this pool). Continue adding batches; numeric
  examples must pin integer/fractional input contracts (soundness S4) to stay
  sound. (refs: docs/ideation/realworld-function-batch*.md;
  docs/changes/realworld-functions-batch9/)
- **Blockers:** —
- **Plan:** —

## Intake

### canary-pr-guardian

- **Status:** done
- **Spec:** docs/changes/canary-pr-guardian/proposal.md
- **Summary:** DONE (#312) — shipped as the PR test-guardian: a deterministic
  Tier-0 diff-coverage engine (`agent/guardian/pr_check.py` + `coverage.py`, CLI
  `canary guardian pr-check`) that posts fidelity-labeled findings
  (coverage-verified › graph-verified › heuristic) with no
  agent/secret/write-token, plus a PR surface
  (`.github/workflows/guardian.yml` + sticky comment), a pre-commit hook
  (`hooks/guardian_precommit.py`), an at-desk agent orchestrator
  (`agent/guardian/agent_tier.py` +
  `agents/skills/claude-code/canary-pr-guardian/` + `/canary-pr-guardian`), and
  harness-check emit (`agent/guardian/analysis_emit.py`, `--emit-analysis`).
  Gate defaults to soft; promote to hard per-repo once trust is earned.
  Capability boundary (SC-11): the Tier-0 engine imports no agent/LLM. Phases
  1–6 all shipped. (refs: docs/changes/canary-pr-guardian/,
  docs/adr/0007-guardian-agent-capability-boundary.md,
  docs/adr/0008-guardian-canary-owned.md, docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** docs/changes/canary-pr-guardian/plans/

### Cobertura XML coverage parser for guardian

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation top pick (score 6.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Extend the guardian
  coverage-verified tier to parse Cobertura coverage.xml, which
  agent/guardian/coverage.py currently falls through on (unrecognized format ->
  drops to graph/heuristic tier). Broadens coverage-verified fidelity to
  Java/.NET/JS-Istanbul pipelines. Accepted risk to handle in spec: Cobertura is
  not one format (Jacoco vs Istanbul dialects differ in DTD/rate attrs) - pin to
  a named dialect and reject unrecognized shapes loudly rather than guess. Low
  effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Framework-registry depth audit + capability tiers

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 6.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md.
  agent/frameworks/registry.json lists 21 frameworks but breadth exceeds depth;
  audit which have real generation/analysis support vs name-only and publish
  honest capability tiers so adopters do not hit a stub. Accepted risk to handle
  in spec: a point-in-time matrix rots - pair it with a coverage test that
  derives tiers from the registry rather than hand-maintained prose (drift-bait
  otherwise, ironic for canary). Low effort / high confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Coverage-json producer contract doc + validator

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 6.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Document + validate
  the canary coverage-json format that agent/guardian/coverage.py consumes, so
  third-party tools can emit canary-consumable coverage. Accepted risk to handle
  in spec: documenting today's accidental shape freezes its warts - do a minimal
  shape review first, frame as version:1 with additive-safe evolution (mirrors
  test-reporter/instrument contracts). Low effort / high confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Guardian hard-gate rollout automation

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 4.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Automate the
  soft->hard guardian gate flip: required-check registration + operator playbook
  (memory: hard-gate needs admin required-check registration). Accepted risk to
  handle in spec: branch-protection required-checks need admin scope and vary
  across GH Free/Team/Enterprise - detect plan/permission and fail loud with a
  manual-steps fallback rather than silently no-op (consistent with the
  fail-loud pattern from #294/#295). Medium effort. Next: /harness:brainstorming
  to spec.
- **Blockers:** —
- **Plan:** —

### Wire quality_scorer into the guardian gate

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md.
  agent/core/quality_scorer.py scores assertions/flakiness/magic-numbers but
  that signal is not consumed by the guardian gate, which only flags ABSENT
  tests, not WEAK ones (e.g. an added test that asserts nothing passes green).
  Accepted risk to handle in spec: a weak-test heuristic firing on legit
  table-driven/snapshot tests erodes trust - ship as advisory (non-blocking)
  fidelity-labeled finding first with a conservative high-precision threshold
  before any gate promotion. Medium effort. Next: /harness:brainstorming to
  spec.
- **Blockers:** —
- **Plan:** —

### Flakiness detector skill over test-reporter history

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. A skill that
  ingests N canary-test-reporter run JSON artifacts and statistically flags
  flaky tests (pass/fail alternation) rather than diagnosing a single run.
  CORRECTED 2026-07-21 - THE STATED RISK WAS FACTUALLY WRONG WHEN WRITTEN. This
  entry claimed "historical run JSON is not persisted anywhere today" and scoped
  v1 to stateless caller-supplied artifacts on that basis. But `agent/history/`
  shipped 2026-06-10 (commit 72e884b), five weeks before this entry was
  authored, and already provides persistence (`canary history push`), queries
  (`flaky`/`timeline`/`summary`), AND flake-trend classification in
  agent/history/detector.py. Rescope: determine what detector.py does NOT yet
  cover (pass/fail alternation vs. trend classification) and wire a skill over
  the existing store rather than building a stateless v1. Effort likely LOWER
  than the original medium estimate. Suggested themed name: `canary-misfit`
  (teleports between pass and fail); naming only, no scope change. Next: gap
  analysis against detector.py, then /harness:brainstorming. (refs:
  docs/ideation/bop-themed-canary-skills-2026-07-21.md; agent/history/)
- **Blockers:** —
- **Plan:** —

### Generated-test soundness linter

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Reject generated
  tests that pin non-deterministic values or leave numeric input contracts
  unpinned (ties to realworld S4 integer/fractional soundness rule). Accepted
  risk to handle in spec: agent/core/static_linter.py and quality_scorer.py
  already exist - EXTEND them with the new rule in-place rather than adding a
  third overlapping half-enforcer. Medium effort. Next: /harness:brainstorming
  to spec.
- **Blockers:** —
- **Plan:** —

### Guardian coverage-delta (regression on touched units)

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Flag coverage
  REGRESSION on units a PR touches (vs base), not just absent coverage; reuse
  the existing agent/guardian/delta_emitter.py seam. Accepted risk to handle in
  spec: needs a base-branch coverage artifact most CI does not upload - degrade
  to 'delta unavailable - head-only' with a loud note when no base artifact is
  present. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Edge-case-discovery to generate-test handoff

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 2.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Wire
  canary-edge-case-discovery output directly into canary-generate-test input so
  users stop re-describing discovered cases by hand. Accepted risk to handle in
  spec: the separation may be intentional (discovery exploratory, generation
  committal) - wire as an explicit human-confirmed pass-through (discovery emits
  a structured artifact the user reviews before generation consumes it), not an
  automatic pipe. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### Mutation-testing signal via Stryker

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 1.00, lowest / stretch) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Surface a mutation
  score (Stryker, already in the framework registry) as a coverage-quality
  signal - 'lines covered but assertions do not kill mutants'. Accepted risk /
  DEFERRED: Stryker per-PR is minutes-to-tens-of-minutes; without diff-scoped
  incremental mutation it is DOA in CI, and incremental mutation is itself hard.
  Revisit only if a diff-scoped mutation spike proves tractable. High effort /
  low confidence. Next: spike before /harness:brainstorming.
- **Blockers:** —
- **Plan:** —

### canary-cry — pre-launch "try to break it" exploratory sweep

- **Status:** backlog
- **Spec:** —
- **Summary:** New skill (`agents/skills/claude-code/canary-cry/`,
  `/canary-cry`) for timeboxed adversarial exploration ahead of a launch, so a
  sales demo never has to explain away a bug. Targets real-world abuse of
  ordinary user flows rather than function-level inputs: impatient
  double/triple-submit of a CTA on a degraded network, back-button or
  force-close midway through a multi-form flow that already wrote partial rows,
  a second user on a shared machine signing out and signing up as themselves
  against stale session/cache/autofill state, plus duplicated-tab,
  token-expiry-mid-flow, and stale-optimistic-UI variants. Success criterion is
  state corruption ("platform left in a bad state"), not merely a rendering
  defect. Tiered execution: always emits a ranked scenario matrix (works with
  zero infra); when a live non-prod target plus credentials are supplied it
  additionally drives the app (Playwright MCP) and reports what actually broke,
  degrading loudly rather than silently skipping (per the #294/#295 fail-loud
  pattern). Timeboxed via an `--amplitude` dial where amplitude is how hard each
  flow is pushed and radius is how many flows are hit: `whisper`
  (narrow/shallow, ~30-60 min, routine major release) / `shout` (moderate, ~2-4
  hrs, new-client onboarding) / `scream` (full radius, max depth, unbounded —
  initial launch and demo hardening). Composes rather than forks:
  canary-edge-case-discovery for case generation, canary-critical-areas +
  canary-failure-impact for radius ranking, canary-company-knowledge for
  org-specific flows and the user catalog, canary-test-reporter for output.
  Accepted risks to handle in spec: (1) `scream` against a live target is
  genuinely destructive — spammed CTAs and killed mid-write flows can corrupt
  shared data and fire real emails/payments/webhooks, so require an explicit
  non-prod target allowlist, refuse prod by default, and print a dry-run
  manifest before the first write; (2) an unbounded `scream` is a token and
  wall-clock bomb — needs convergence criteria (stop after K consecutive barren
  rounds) and resumable checkpoints rather than "explore until done"; (3) a
  finding without a deterministic repro is noise — every finding must carry
  replayable steps plus seed/state, or it cannot be triaged before the launch it
  was run for. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-katana — deleted-test quarantine

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 1 (score 6.75) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Capture every deleted or
  skipped test with provenance (who, when, what it covered) instead of letting
  it vanish silently, and alarm when a deletion drops the LAST coverage on a
  critical-area symbol. Test deletion is an untracked coverage-regression
  vector. Accepted risk to handle in spec: most deletions are legitimate (dead
  feature removal, genuine dedup), so alarming on every one becomes nag fatigue
  and a muted gate is worse than no gate - ship silent-by-default, firing only
  on last-coverage-of-critical-area. Deterministic/Tier-0 (git diff + coverage
  set math, no LLM). Low effort / high confidence. Next: /harness:brainstorming
  to spec.
- **Blockers:** —
- **Plan:** —

### canary-savant — test order-dependence and isolation detector

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 2 (score 6.75) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Shuffle and
  run-alone-repeat the suite to surface tests that only pass in a specific
  order, exposing shared-state leakage - a classic hidden flake source. OVERLAP
  VERIFIED AND CLEARED 2026-07-21: the v5.11.0 concern was commit 8c5835f, which
  touched exactly one file (tests/unit/test_skill_registry.py, +39 lines) to
  isolate one test class from home overlays - canary's own suite hygiene, not a
  user-facing capability. No shuffle or order-dependence code exists anywhere in
  agent/. This is a genuine, distinct idea. Accepted risk to handle in spec: a
  shuffled re-run doubles suite wall-clock, so it must be opt-in/scheduled
  rather than a per-PR default, and it must report the seed so a failure is
  reproducible. Deterministic/Tier-0. Low effort / high confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-blackhawk — temporal-dependency linter

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 3 (score 6.75) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Statically flag tests
  depending on wall-clock, timezone, or DST - the ones that pass all day and
  fail at midnight, across a DST boundary, or on a leap day. Accepted risk to
  handle in spec: frozen-clock idioms differ per framework (vi.useFakeTimers,
  freezegun, jest.setSystemTime), so a naive AST rule false-positives on tests
  that already handle time correctly - condition the rule on the detected
  framework via agent/frameworks/registry.json rather than applying it
  universally. Deterministic/Tier-0. Low effort / high confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-signal — QA impact digest

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 4 (score 6.75) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Broadcast a periodic
  digest of what testing actually caught - bugs prevented, sweeps run, escapes
  avoided - to Slack, Teams, or a PR comment, so the work of testing is visible
  to people who do not open the code. Serves STRATEGY.md track 5 (Quality made
  legible). CORRECTED 2026-07-21: the original entry blocked this on
  canary-clocktower on the belief that no run history is persisted. That belief
  was FALSE - `agent/history/` (shipped 2026-06-10, commit 72e884b) already
  provides a persisted store with `canary history push|flaky|timeline|summary`.
  This item is NOT blocked; it is a formatter/broadcaster over existing query
  output. Accepted risk to handle in spec: the digest must degrade honestly when
  history is thin - a digest reading "1 run, 0 escapes" UNDERSELLS QA and
  inverts the goal, so state the window size and sample count explicitly rather
  than implying a quiet week. Low effort / medium confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-clocktower — run-history gap analysis (NOT a greenfield build)

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 5 (score 5.25) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. CORRECTED 2026-07-21 -
  THE ORIGINAL PREMISE WAS FALSE. The ideation claimed run artifacts "are
  stateless and ephemeral today" and framed this as a greenfield substrate. In
  fact `agent/history/` shipped 2026-06-10 (commit 72e884b) with schema.py,
  store.py (abstract + factory), local_store.py, supabase_store.py, detector.py
  (flake-trend classification), a `canary history` CLI
  (push/flaky/timeline/summary/migrate), and four unit-test files. The ideation
  was generated from roadmap/doc text that had itself drifted, and the false
  claim propagated into this entry. Rescope to a GAP ANALYSIS: what does
  canary-test-reporter NOT yet push into history, and which consumers
  (canary-signal, the flakiness item) are not yet wired to query it. Accepted
  risk to handle in spec: do not rebuild what exists - the deliverable is wiring
  plus a documented gap list, not a second store. Effort unknown until the gap
  analysis runs. Next: gap analysis, then /harness:brainstorming.
- **Blockers:** —
- **Plan:** —

### canary-manhunter — release quality dossier

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 6 (score 5.25) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Assemble the full
  evidentiary case for a release - coverage tiers, guardian findings, sweep
  results, escape history - into one signed report aimed at client-success and
  delivery staff. Serves STRATEGY.md track 5 (Quality made legible). Accepted
  risk to handle in spec: reporting with no decision attached is theater and
  becomes a PDF nobody opens, the most common way quality tooling dies - the
  dossier must gate something real (a release checklist item) or answer a
  question someone is already asking under time pressure, or it should not be
  built. Medium effort / high confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-cassandra — vacuous-test detection

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 7 (score 3.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Diff execution traces
  (from canary-instrument's OTel) against each test's declared target to find
  tests that PASS WITHOUT EVER INVOKING the code they claim to cover. Addresses
  the STRATEGY.md target problem more directly than any other candidate in the
  batch; its mid rank is driven by effort and confidence, not relevance.
  Accepted risk to handle in spec: "declared target" is not declared anywhere
  and must be inferred from test names/imports - precisely the heuristic tier
  the strategy distrusts, and it will confidently flag a correct integration
  test as vacuous when the call sits several frames deeper. Needs an explicit
  @covers annotation or trace-to-symbol resolution good enough to earn
  graph-verified rather than heuristic. Medium effort / medium confidence. Next:
  /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-question — test-bug vs product-bug triage

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 8 (score 3.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Interrogate a failure
  and classify it as a false-fail (test defect) or a real SUT defect, showing
  its reasoning - the "is this a test bug or a real bug" question that currently
  costs triage time on every red build. Accepted risk to handle in spec: a wrong
  triage is WORSE than no triage - "it's just a flaky test" stamped on a genuine
  product bug is exactly how defects escape, and it would degrade the
  escaped-defect headline metric while appearing to help. Must never emit a
  confident verdict: fidelity-labeled hypothesis plus evidence, never a
  disposition. Medium effort / medium confidence. Next: /harness:brainstorming
  to spec.
- **Blockers:** —
- **Plan:** —

### canary-judomaster — incident to regression test

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 9 (score 3.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Turn a production
  failure (stack trace, repro, incident record) into a failing regression test
  that pins the defect - using the failure's own force. Directly serves the
  STRATEGY.md headline metric (escaped-defect ratio) by converting escapes into
  permanent coverage. Accepted risk to handle in spec: it needs structured
  incident input most orgs lack in machine-readable form (in practice you get a
  Slack thread and a screenshot), so it demos well then sits unused - ship a
  degraded path that accepts a pasted stack trace alone. Medium effort / medium
  confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-ivy — suite overgrowth and pruning

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 10 (score 2.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Detect metastasized
  suites: duplicated fixtures, tests covering nothing not already covered, and
  runtime creep over time. PREMISE NEEDS RESHAPING BEFORE SPEC - the objection
  is severe enough to invalidate the current framing. Accepted risk to handle in
  spec: recommending test DELETION is the most dangerous advice a test tool can
  give, because a "redundant by coverage" test may be the only one asserting the
  behavior that breaks - line coverage does not capture assertion intent, and
  this directly contradicts canary's own target problem (coverage overlap is not
  equivalent proof). Reframe toward runtime/duplication reporting without
  deletion recommendations, or drop. Medium effort / medium confidence. Next:
  reshape premise, then /harness:brainstorming.
- **Blockers:** —
- **Plan:** —

### canary-harley — property-based and fuzz test generation

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 11 (score 2.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Generate property-based
  tests (fast-check, Hypothesis) with shrinking rather than example-based cases
  - input-level chaos, distinct from canary-cry's user-flow exploration and from
    canary-edge-case-discovery's reasoning about named cases. Accepted risk to
    handle in spec: property-based testing needs an INVARIANT, and articulating
    the invariant is the entire hard part - generating framework boilerplate
    around a weak or wrong property produces confident nonsense that shrinks to
    a meaningless minimal case. The real output should be a proposed invariant
    the human confirms, with codegen downstream of that confirmation. Medium
    effort / medium confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-huntress — targeted regression pursuit

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 12 (score 2.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Hunt one specific defect
  CLASS across the entire suite and its history, rather than exploring broadly.
  First attempt to give the previously reserved canary-huntress name a scope; it
  did not clear the bar, so the name remains reserved. Accepted risk to handle
  in spec: git bisect already finds WHEN a regression entered and canary-cry
  explores broadly, so the remaining slice (find every OTHER place this same bug
  shape exists) may be too narrow to justify a skill rather than a flag on an
  existing one - this is a reserved name looking for a job, which is the wrong
  direction of fit. Medium effort / medium confidence. Next: find a genuinely
  distinct scope before speccing, or leave the name reserved.
- **Blockers:** —
- **Plan:** —

### canary-hawk-dove — gate threshold auto-tuner

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 13 (score 1.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Balance aggression
  against noise by tuning gate thresholds from the historical false-positive vs.
  escaped-defect record - the recurring "erodes trust" worry across the guardian
  items, solved with data instead of guesswork. Accepted risk to handle in spec:
  it requires ground-truth labels on past findings (was this finding real?) that
  nobody records, so without them it tunes on noise and produces a confidently
  wrong threshold - it is blocked behind both a history substrate and a labeling
  ritual humans will not reliably perform. High effort / low confidence; treat
  as a stretch item. Next: spike the labeling question before
  /harness:brainstorming.
- **Blockers:** no ground-truth outcome labels exist on past findings (the
  history store itself EXISTS - agent/history/, 2026-06-10 - so the substrate is
  not the blocker; the missing labels are)
- **Plan:** —

### canary-batgirl — developer and team quality scorecard

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 14 (score 1.00) from
  docs/ideation/bop-themed-canary-skills-2026-07-21.md. Streaks, badges, and
  rank derived from canary audit scores, recognizing sound and stable code.
  Serves STRATEGY.md track 5 (Quality made legible); the track legitimizes the
  goal but does not resolve the objection, which is why confidence stays low.
  Accepted risk to handle in spec - THE SHARPEST IN THE BATCH: Goodhart's law
  points this at canary itself. Scoring engineers on canary metrics makes them
  optimize the score, and the cheapest way to raise almost any coverage-derived
  score is to write more assertion-free tests - so a naive reward system would
  actively MANUFACTURE canary's own target problem. Safe only if it scores
  things that are expensive to fake (escaped-defect ratio, coverage-verified
  finding share) and never anything a developer can inflate by adding green.
  Medium effort / low confidence. Next: /harness:brainstorming to spec.
- **Blockers:** — (history substrate EXISTS: agent/history/, 2026-06-10; the
  Goodhart objection remains the real gate, not a missing store)
- **Plan:** —
