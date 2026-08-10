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

### harness-config-denominator — cover knowledge.domainBlocklist

- **Status:** backlog
- **Spec:** —
- **Summary:** ts/test/harness-config-denominator.test.ts encodes four invariants against vacuous rules in harness.config.json — every layers[].pattern, forbiddenImports[].from/disallow, and allowedDependencies name must match something real, and every tracked source file must belong to a layer. PR #563 added knowledge.domainBlocklist, which can go vacuous the same way: a segment matching no real path still reports as configured. It already bit once — two of four initially-blocklisted segments (.claude, .cursor) matched no graph nodes. Extend the test with a fifth invariant so a blocklist entry that matches nothing fails rather than reading as protection. Same class as #481 and #544: a rule that checks zero things is an abstention, not a pass.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#564

### Field contract — extend it to the archive and shard output

- **Status:** backlog
- **Spec:** docs/changes/roadmap-priority-and-field-contract/proposal.md
- **Summary:** #628 fixed docs/roadmap.md and guards it with ts/test/roadmap-field-contract.test.ts, but three gaps remain. (1) docs/roadmap-archive.md carries the identical defect — 60 wrapped Summary fields, no Priority, still prettier-governed and therefore held that way — and roadmap-groom.mjs moves rows into it verbatim, which makes the archive prettier-dirty and blocks every subsequent agent write to it. (2) The guarded set is a hardcoded single path, so committed shard output would go unscanned while both denominators stayed non-zero; derive it from .prettierignore so the exempted and guarded sets are the same set mechanically. (3) The test detects wrapping but not truncation — a file already flattened by shard+regen is one-line-clean and passes — so it needs a content floor. Deferred from #628 deliberately: item 1 is 60 rows of prose, and items 2-3 are only worth building once the archive is in the guarded set.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#630

### agents-roadmap-counts checks a claim it cannot derive

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #640, found while grooming in #639. ts/test/agents-roadmap-counts.test.ts extracts three claims from AGENTS.md and asserts each equals the linked-row count, but the third pattern captures "(N of M open issues carry the label today)" — labelled open issues, a quantity with no reason to equal the number of rows. It passes only because both are currently equal, and the file's own docstring says the open-issue side is deliberately not checked, so the intent and the implementation disagree. Two failure modes, both bad: a false red on a correct edit that changes rows without changing labels, where the obvious fix is to edit the prose into being wrong; and a false green on the claim it is nominally guarding, which is the shape the file was written to catch. Fix is to drop the third pattern and lower the length floor to 2, or assert it against something derivable offline.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#640

### Execute the documented commands — run SKILL.md examples in CI

- **Status:** backlog
- **Spec:** —
- **Summary:** Docs promise commands nothing has ever executed. #472 added a `canary skills run canary-blackhawk -- --help` example in the same PR that left the command broken — mode 644, so the spawn hit EACCES and mapped to a bare exit 1 with no output. Same class as #465 (architecture page describing an engine deleted four majors earlier) and #455 (operator guide pointing at a file deleted as dead code): plausible prose, nothing executing it. Extract each SKILL.md example and run it in CI, catching missing exec bits, broken --help and flag handling, references to deleted files or renamed flags, and unresolvable `cli:` paths in one pass.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#487

### Three test-design rules the port would have benefited from

- **Status:** backlog
- **Spec:** —
- **Summary:** Three mechanically-checkable rules, each drawn from a specific bug this cycle, sharing one theme — the tests exercised the shape the author was thinking about, not the shape a user hits. (1) Every CLI option with a fallback needs a test that OMITS the flag: #369 defaulted --diff to a bare `git diff`, empty on a clean CI checkout, and every test passed a diff explicitly, so the default path had zero coverage and the gate scoped zero paths across ~5 PRs. (2) Anything persistent needs a removal test: #456 proved a sentinel was written but never that it was cleared, so deleting the clearing half silently disabled Tier-2 authoring permanently. (3) Scale rules per the issue body.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#488

### check-arch and ci check disagree on the same architecture data

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #626, split out of #622. `harness check-arch` exits 1 with "Validation failed (28 issues)" while `harness ci check` — the command the required `harness` job actually runs — reports `arch: pass` and exits 0, from the same data. Both are correct: check-arch counts absolute violations, ci check counts the delta against the baseline, and all 28 findings are baselined complexity. Neither output says which number it is reporting, so a human running the local command reads a green CI job as a disagreement rather than as a different question, and a genuine new violation is indistinguishable from the standing baseline. The fix is wording, not thresholds — each output should name its own mode. Priority is P1 rather than P0 under the predicate in AGENTS.md: the required check is right, and only the local command misleads. Same family as #588 (a report CI truncated) and #584.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#626

### harness roadmap regen strips the roadmap's header comment block

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #629, found while verifying #628 against `@harness-engineering/cli` v10.2.0. A `harness roadmap shard` + `regen` round-trip deletes this file's 8-line header comment — including the `markdownlint-disable-file MD013` directive and the note recording why each field must stay one physical line — and exits 0 both ways with no warning. Field values survive intact. Latent rather than active: neither subcommand is referenced by any workflow or script in this repo, so it only bites someone running them by hand, which is why it is P3 rather than P1 — no CI path and no dependent rows. The hazard is that the tooling erases its own contract note, after which the `.prettierignore` exemption reads as arbitrary and the next cleanup reflows the file. `ts/test/roadmap-field-contract.test.ts` asserts the comment is present, so the loss fails a check rather than passing silently.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#629

### harness check-perf abstains — performance.entryPoints is never declared

- **Status:** in-progress
- **Spec:** —
- **Summary:** Issue #638, found while triaging #544. `harness ci check` reports `perf: warn — Could not resolve entry points`, inside the required `harness` job. Same failure class as #544 at a different config key: the entropy analyzer reads `entropy.entryPoints`, the perf checker reads `performance.entryPoints`, and harness.config.json declares the latter nowhere, so auto-detection fails and the check reports a colour instead of an abstention. P0 under the written predicate — a check in required-checks.json is wrong, in that `warn` claims a measurement that never happened. Pre-existing on main and unchanged by #637, which is why it was filed rather than folded in: it needs its own decision about whether the repo wants perf budgets at all, and either answer must be legible — declared roots mirroring the entropy list, or the check turned off explicitly rather than left auto-detecting and failing. The gate-conformance route is the same one #544 took: a missing count exits 3, never 0.
- **Blockers:** —
- **Plan:** —
- **Priority:** P0
- **External-ID:** github:bop-clocktower/canary#638

### refresh-arch-baseline is a no-op on the case it exists for

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #634. The refresh-arch-baseline workflow exists for exactly one situation — the arch ratchet inside the required `harness` job trips and the baseline needs regenerating — and does nothing in that situation, so the red gets waited out or refreshed by hand locally instead. A repair tool that silently declines to repair is worse than no tool, because its existence is what stops someone building the manual habit. Adjacent to #626: that row is about the arch verdict being unreadable, this one is about the documented remedy not working, and the two are one sitting together. P3 rather than P1 by the written predicate and worth naming as such — the workflow is not reachable from a consumer CLI or skill invocation, has no open PR, and no other row blocks on it, so it lands in the residual bucket the way #629 did. That is a gap in the scale, not a judgement that the bug is small.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#634

### Resolve roadmap api-signature doc drift

- **Status:** blocked
- **Spec:** —
- **Summary:** PARTIALLY MITIGATED, still blocked on a narrower upstream gap. Original blocker (Intense-Visions/harness-engineering#723: analyze.drift config ignored + Python symbol mis-resolution) was fixed upstream via harness#724 and issue #246 closed 2026-07-15 after re-verification (roadmap.md's own residual findings dropped from ~60 to 6, non-blocking warn severity). Project-side, `entropy.analyze.drift.checkApiSignatures: false` was added to harness.config.json, verified via `harness cleanup --json` to fully suppress findings (1450 -> 0). However, `harness ci check` — what this repo's CI workflow actually runs — has its own separate, still-unfixed code path that does not honor this config at all (same config, 0 findings via cleanup vs. 1450 via ci check). That fourth call site is the new, narrower blocker. Findings remain non-blocking (warn severity) regardless. Revisit when the upstream fix lands. (refs: Issue #246 [closed]; Issue #266; upstream harness#838) [Note: symbol names intentionally omitted from this summary so the drift-tracking row does not itself register as drift.]
- **Blockers:** upstream harness#838 (`harness ci check` doesn't thread entropy.analyze.drift config)
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#601

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

### Generated-test soundness linter

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Reject generated tests that pin non-deterministic values or leave numeric input contracts unpinned (ties to realworld S4 integer/fractional soundness rule). Accepted risk to handle in spec: agent/core/static_linter.py and quality_scorer.py already exist - EXTEND them with the new rule in-place rather than adding a third overlapping half-enforcer. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#605

### Guardian coverage-delta (regression on touched units)

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Flag coverage REGRESSION on units a PR touches (vs base), not just absent coverage; reuse the existing agent/guardian/delta_emitter.py seam. Accepted risk to handle in spec: needs a base-branch coverage artifact most CI does not upload - degrade to 'delta unavailable - head-only' with a loud note when no base artifact is present. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#606

### Edge-case-discovery to generate-test handoff

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation pick (score 2.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. Wire canary-edge-case-discovery output directly into canary-generate-test input so users stop re-describing discovered cases by hand. Accepted risk to handle in spec: the separation may be intentional (discovery exploratory, generation committal) - wire as an explicit human-confirmed pass-through (discovery emits a structured artifact the user reviews before generation consumes it), not an automatic pipe. Medium effort. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#607

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

### canary-cassandra — vacuous-test detection

- **Status:** backlog
- **Spec:** —
- **Summary:** Ideation rank 7 (score 3.00) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Diff execution traces (from canary-instrument's OTel) against each test's declared target to find tests that PASS WITHOUT EVER INVOKING the code they claim to cover. Addresses the STRATEGY.md target problem more directly than any other candidate in the batch; its mid rank is driven by effort and confidence, not relevance. Accepted risk to handle in spec: "declared target" is not declared anywhere and must be inferred from test names/imports - precisely the heuristic tier the strategy distrusts, and it will confidently flag a correct integration test as vacuous when the call sits several frames deeper. Needs an explicit @covers annotation or trace-to-symbol resolution good enough to earn graph-verified rather than heuristic. Medium effort / medium confidence. Next: /harness:brainstorming to spec. NAME COLLISION RESOLVED 2026-08-07: Issue #460 also claimed `canary-cassandra`, for predictive test ordering — an unrelated feature. This row keeps the name (Cassandra Cain reads the fake, which is what vacuous-test detection does); #460 was renamed `canary-shiva` and has its own row below. The collision was possible because roadmap rows and tracker issues both mint Birds of Prey names and neither reads the other.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#612

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

### canary-screech — broken-main siren

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into Issue #591. Wave 1, small and visible. When the default branch goes red, emit a one-page blast: culprit commit range, failure cluster, owning area, a quarantine-or-revert recommendation, and a chat-ready block. Distinct from canary-fail-fast (in-run, aborts early) and canary-test-reporter (per-run summary) — neither looks across runs or knows the branch went red. Open in #591: where the branch-is-red signal comes from (Actions webhook, polling, or the history store), and whether it posts the blast or only emits it.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#591

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

## Engine and Platform

### ADR — sync vs async history-store interface for the TS cutover

- **Status:** backlog
- **Spec:** —
- **Summary:** Python's HistoryStore ABC is synchronous, but @supabase/supabase-js is async-only, so the TS port introduced an AsyncHistoryStore contract rather than mirroring the sync shape. Fine while both engines run side by side; at cutover the async interface propagates upward and AnalysisEngine plus every consumer must become async too — a cross-cutting shape decision, not a local one. Three options to weigh: async all the way up, a sync facade over async, or split read/write so the local NDJSON path stays sync and only Supabase is async behind a capability check. Decide before porting core/ and guardian/ so those adopt the final shape.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#390

### Shared skill-CLI arg parser and table-driven conformance suite

- **Status:** backlog
- **Spec:** —
- **Summary:** Five skills hand-roll their own parseArgs and share four invariants — null-prototype lookup for value-flag maps, empty-value rejection in both spellings, arity checking, and --flag=value support — with nothing enforcing any of them. The only thing holding the line is a block of tests hand-copied into each suite, which is exactly how they get weakened: during #472 two copies drifted, and canary-fail-fast’s prototype test was structurally unreachable and passed against the buggy code. No test today would catch a sixth skill landing with a plain-object VALUE_FLAGS. canary-shadow (#478) is the proof it already happened.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#479

### Persona system as a first-class engine concept

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #462, split from #340. Audience adaptation is hand-rolled per skill today — each re-implements some variant of "if tester, use simpler words" — so tone drifts between skills and an overlay cannot override it. Replace with a persona definition (audience, technical depth, preferred output formats, voice) that skills CONSULT rather than reimplement, extensible by downstream overlays through the same `precedence` arbitration the overlay contract already defines. Inventory the existing surface first: `canary doctor --audience` (renamed from `--persona` in v5.12.0, legacy aliases retained), the sdet/tester onboarding tracks, and the tester-facing skills that scale run-summary tone. Accepted risk to handle in spec: if the persona is inferred rather than configured this collides with Issue #341, and inferring an audience wrongly is the failure mode users notice and resent; the no-persona fallback must be a real good default, not a degraded mode.
- **Blockers:** —
- **Plan:** —
- **Priority:** P2
- **External-ID:** github:bop-clocktower/canary#462

### Voice pack and themable external-report hooks

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #340, retitled 2026-08-07 off the "Clocktower voices" name that collided with the canary-clocktower row above. The project has a voice identity but it stops at one character in one file. Build out distinct voices for the Birds of Prey cast with a small style guide each, use them across session responses, report flavor lines, doc epigraphs, and CLI moments, and provide the engine-side hook for external-facing reports (a themable footer slot plus a clean way for overlays to inject brand styling into HTML output). Accepted risk to handle in spec: voice is garnish and never load-bearing — every voiced line carries the plain fact too, and a `--no-flavor` off-switch must exist for CI logs and formal contexts. Sequencing: voice attaches to a persona, so Issue #462 wants to land first or the pack ships unwired. New names must not collide with a shipped skill or an existing row — the failure this reconciliation just cleaned up; `cassandra` and `clocktower` are spoken for and `oracle` is retired and never reused.
- **Blockers:** Issue #462 (personas — voice needs something to attach to)
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#340

### Skill Forge primitives — cross-surface consistency and reachability

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #452. A skill exists across several surfaces at once (the SKILL.md, the plugin manifest, the slash command, the agent definition, the docs), and nothing checks that those agree or that every declared skill is actually reachable. Build the two primitives: a cross-surface consistency check and a reachability sweep. Accepted risk to handle in spec: this is denominator-shaped work, so the check must report what it could not examine rather than passing quietly — a sweep that finds zero unreachable skills because it enumerated zero skills is an abstention, not a pass.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#452

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

### Gate canary-promote-test on structured test-craft verdicts

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #477. Promotion out of `tests/generated/` into the committed suite is currently a review-and-move flow with no machine gate. Require a structured verdict from test-craft before a generated test can be promoted, so the quality bar is enforced rather than remembered. Accepted risk to handle in spec: a gate that blocks promotion needs an abstention path — if test-craft cannot form a verdict, that must be reported as unable-to-assess and not silently treated as a pass, which is the exact failure class the no-silent-abstention work exists to close.
- **Blockers:** —
- **Plan:** —
- **Priority:** P3
- **External-ID:** github:bop-clocktower/canary#477

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

### Monorepo-aware detection and a --framework override that resolves shape

- **Status:** backlog
- **Spec:** —
- **Summary:** Run against a Turborepo + pnpm workspace with Playwright and Vitest already in place, all probes are root-only, so the repo detects as Framework: unknown — root scripts.test is `turbo test`, which matches nothing. The --framework playwright override sets the framework but leaves Shape: unknown, so overlay-skill matching and shape-prefixed workflow templates never fire. Worse, the scaffold proposal then offers to create playwright.config.ts and tests/e2e at the monorepo root, a duplicate suite beside the apps/web-e2e project it never noticed. The dry run also prints "Migration complete" when nothing was migrated.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#504

### review-test LINT-006 reports the line one too low

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #633, found while fixing #590. LINT-006 reports its finding one line above the test it is about, for any test not starting on line 1 — an off-by-one in the line accounting, so the consumer is pointed at the wrong place in their own file. Narrower than #590 and the same kind of damage: a report whose locations have to be distrusted is a report that stops being read, and this one is worse per-finding because a wrong line still looks plausible where a wrong verdict at least invites a second look. P1 under the written predicate — reproducible from `canary review-test`, a consumer-facing CLI invocation. The fix lands in the string-literals module #632 built rather than anywhere new, which is why it is worth doing while that code is still warm.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#633

### canary history record — a writer for the local history store

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #538. The local history store has a schema, a store abstraction, a local and a Supabase backend, a flake-trend detector, and a `canary history` CLI — but no command writes to the local store. The only writer is `dogfood-record-run.mjs`, a script. Promote it to a real `canary history record` command. This is the product-lies class: the capability is documented and the read side exists, so the gap is invisible until someone queries an empty store. It also gates real work — the canary-shiva and canary-rewind rows above both depend on history having content, and the canary-clocktower gap analysis is partly answered by it.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#538

### Uninstall path

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #523. The word "uninstall" appears zero times in README, docs/, and source. Canary writes into consumer repos — skills, workflows, config, generated tests — and offers no documented way to take it back out. Product-lies class, and the one with the clearest reputational cost: a tool that cannot be removed cleanly is a tool people hesitate to install. Accepted risk to handle in spec: uninstall must distinguish what canary authored from what the user has since edited, and must never delete a test someone has come to rely on without saying so first.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#523

### doctor — detect a stale Claude Code plugin

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #522. The CLI and the Claude Code plugin version independently, so a user can run a current CLI against a stale plugin and get behavior from neither. `canary doctor` has no check for this. Tooling-rot class: the failure is silent and presents as inexplicable behavior rather than as a version problem. Small, well-bounded, and directly serves the denominator principle — a doctor that cannot see a whole surface should say so.
- **Blockers:** —
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#522

### Consume the detected environment and user-level context

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #341. Environment and user-level context detection ships and works; nothing reads it. Product-lies class in its purest form — the feature is present, tested, and inert. Wire the existing detection into the consumers that should adapt to it. Accepted risk to handle in spec: the SDET-vs-manual detection half collides with the persona work in Issue #462 and needs its own design default, because inferring a user's skill level wrongly is the failure people resent; decide there whether detection proposes or decides.
- **Blockers:** Issue #462 (persona definition — overlapping audience model)
- **Plan:** —
- **Priority:** P1
- **External-ID:** github:bop-clocktower/canary#341
