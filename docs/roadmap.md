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

### no-silent-abstention

- **Status:** done
- **Spec:** docs/changes/no-silent-abstention/proposal.md
- **Summary:** No Silent Abstention doctrine (#508): every gate reports its
  denominator; zero-verified is a loud, distinct outcome (exit 3 = abstained,
  reserved CLI-wide). Engine `gate-result.ts` helper for ts commands + npm
  scripts, convention + table-driven conformance suite (the canonical gate
  registry) for self-contained skill CLIs. Gates exit 3; advisory commands warn
  loudly with `abstained: true` but exit 0. Five waves, each shippable. WAVE 1
  SHIPPED in v6.4.0 (PR #518): `ts/src/core/gate-result.ts`, the conformance
  registry, the #503 `FreshnessReport` retrofit, and the #504 dry-run abstention
  half. WAVE 2 SHIPPED in v6.4.0 (PR #526): guardian `pr-check` / `harden-gate`
  exit 3, `analyze` / `validate-coverage` warn. WAVE 3 (PR #529): doctor
  denominator + exit 3 + D7 summary, `overlay lint` zero-skill abstention, the
  npm registry, and the `npm package` CI job that had never existed. WAVE 4a (PR
  #530): `review-test` / `flake-check` exit 3 on zero collected files; `analyze`
  and `history` abstain on zero RUNS (not zero rows) via a new `countRuns()`
  probe; `history summary`'s fabricated `0.0%` fixed; `heal-test` / `skills run`
  audited and pinned unchanged. WAVE 4b (PR #531): blackhawk / savant / katana
  abstain, `--strict` inherits exit 3, skill-layer registry. WAVE 5:
  `guardian.yml` handles exit 3 distinctly from exit 1, `continue-on-error`
  steps annotate, ADRs 0009/0010, the AGENTS.md doctrine + new-gate checklist,
  and the CHANGELOG "Gates that got louder" table with the v6.4.0 surfaces
  backfilled. Conformance registries: engine 13 rows, npm 3, skill 6.
  Workflow-template version bumps were N/A — no skill declares
  `install_workflows`. (refs: docs/changes/no-silent-abstention/plans/)
- **Blockers:** —
- **Plan:** docs/changes/no-silent-abstention/plans/

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

- **Status:** done
- **Spec:** —
- **Summary:** DONE — `_parse_cobertura` added to agent/guardian/coverage.py
  (dispatched from `resolve_from_report` on `.xml`), broadening the
  coverage-verified tier to Cobertura `coverage.xml` and thus Java/.NET/JS-
  Istanbul pipelines that previously fell through to graph/heuristic. Pinned to
  the canonical line-level shape (`<class filename><line number hits>`) emitted
  by coverage.py/Istanbul/SimpleCov/Jacoco→Cobertura converters; branch/
  condition data intentionally deferred (downstream index is line-hits). Windows
  `\` paths normalized so .NET/coverlet reports resolve. Non-Cobertura XML is
  rejected (returns None → falls through) rather than guessed at, honoring the
  absence-never-blocks contract. Security (adversarially reviewed): stdlib
  ElementTree kept (Tier-0 no-deps posture preserved — no defusedxml) with a
  full-text (not windowed) guard rejecting DOCTYPE `<!ENTITY>` declarations +
  oversize input, `(OSError, UnicodeDecodeError)`→None on the read path, and
  ParseError→None on malformed input; legit SYSTEM DOCTYPEs still parse. 11 new
  TDD tests (43 in test_guardian_coverage). Original ideation: top pick (score
  6.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs:
  agent/guardian/coverage.py; docs/guides/pr-guardian.md fidelity table)
- **Blockers:** —
- **Plan:** —

### Framework-registry depth audit + capability tiers

- **Status:** done
- **Summary:** DONE (adversarially reviewed) — a new
  `FrameworkRegistry.capabilities` method derives an honest per-framework
  support level from CODE signals, never the subjective status/maturity prose.
  `scaffold` = a scaffolder template exists (scaffoldable_frameworks). `execute`
  = a command the executor can actually RUN — since the executor substitutes
  only `{file}`, this requires `{file}` present OR no placeholder (suite
  runner); a stray `{target}` (zap, semgrep) that would reach the shell
  unsubstituted is NOT counted, so the tier never overpromises. Headline `tier`:
  full (scaffold+execute) / executable / catalog. Case-insensitive. Audit of the
  27 (not 21) advertised frameworks: 5 full, 16 executable, 6 catalog
  (zap/semgrep demoted to catalog for the broken placeholder). Static analysis
  deliberately excluded as a tier signal — the linter's scans are largely
  framework-agnostic, not a per-framework differentiator (avoids re-creating the
  hand-maintained matrix the roadmap warned against). Exposed via summaries() →
  `canary frameworks` (tier column) + MCP list_frameworks. Adopter-hits-a-stub
  fixed across ALL callers: scaffold() degrades loudly (status=unsupported +
  guidance + run command) for a known-no- template framework; `canary init`/MCP
  surface it; `canary migrate` records a manual follow-up instead of a false
  "Migration complete" (review caught this silent-success regression); unknown
  frameworks still raise. Anti-drift: test_framework_capability_tiers.py derives
  tiers from code and fails on orphan templates, un-tierable entries, or a
  scaffoldable-but-unrunnable quadrant. ~19 new tests, full suite green.
  Ideation pick (score 6.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs:
  agent/core/framework_registry.py, scaffolder.py, migrator.py;
  docs/guides/framework-registry.md capability-tiers section)
- **Spec:** —
- **Blockers:** —
- **Plan:** —

### Coverage-json producer contract doc + validator

- **Status:** done
- **Spec:** docs/specs/coverage-json-contract.md
- **Summary:** DONE — documented the coverage-json format
  agent/guardian/coverage.py consumes as a frozen v1 contract
  (docs/specs/coverage-json-contract.md, mirroring the api-delta-contract style)
  so third-party tools can emit canary-consumable coverage. Shape review first
  surfaced the warts and froze them deliberately: `line_hits` is authoritative
  (only it expresses hits=0 = instrumented-but-unhit), `covered_lines`
  documented as a shorthand for hits>=1, optional `schema_version` (absent ⇒ 1
  so today's producers stay valid; additive-safe, unknown keys ignored). Added
  `validate_coverage_json()` in coverage.py (co-located with the parser so they
  can't drift) + `canary guardian validate-coverage <file>` — LOUD where the
  parser is silent, two-tier: error = parser drops it (coverage lost, exit 1) vs
  warning = sub-part ignored (degraded, exit 0 / 1 under --strict);
  missing/non-JSON exits 2. A binding test asserts the validator's verdict
  matches what the parser actually does. 26 new tests, full suite green.
  Ideation pick (score 6.00) from
  docs/ideation/deepen-core-test-intelligence-2026-07-19.md. (refs:
  agent/guardian/coverage.py, agent/guardian/cli.py; docs/guides/pr-guardian.md
  formats note)
- **Blockers:** —
- **Plan:** —

### TestTracker ingest reporter (interim)

- **Status:** in-progress
- **Assignee:** <brianna.stevenski@example.com>
- **Spec:** docs/changes/testtracker-ingest-reporter/proposal.md
- **Summary:** Config-driven Playwright reporter shipped from `canary-test-cli`
  (`canary-test-cli/reporter`) that pushes runs to the TestTracker / QA
  Intelligence Dashboard ingest API. Consolidates the drifted per-repo
  `testtracker-reporter.ts` (consumer-a-api/web) into one versioned reporter;
  onboards Consumer B (consumer-b-api + consumer-b-web). INTERIM precursor to
  the spec-pure `canary publish` (see canary-internal unified-reporting spec),
  which is blocked on Phase 2a (`canary report`). Convergence + deprecation path
  documented in docs/wiki/TestTracker-Reporter.md.
- **Blockers:** publish/link canary-test-cli@5.15.0; dev TestTracker
  tenant+token (human).
- **Plan:** docs/changes/testtracker-ingest-reporter/plans/

### Guardian hard-gate rollout automation

- **Status:** done
- **Spec:** —
- **Summary:** DONE (adversarially reviewed) — `canary guardian harden-gate`
  automates the admin step the operator guide said the guardian couldn't do:
  registering the guardian status check (`guardian` job, `--check` overridable)
  as a REQUIRED check in branch protection, which is what makes a `gate: hard`
  finding block the merge button. Dry-run by default (shows plan + manual
  steps); `--apply` PATCHes branch protection MERGING into existing rules (never
  clobbers), or PUTs minimal protection if none exists. Fail-loud per #294/#295:
  no admin scope / unsupported plan / missing token → prints a manual playbook
  (Settings URL + ready-to-paste `gh api`) and exits non-zero, never a silent
  no-op. Structure mirrors pr_comment (BranchProtection Protocol +
  FakeBranchProtectionClient + urllib RestBranchProtectionClient), so the pure
  planner (plan_hard_gate) and apply path are fully network-free-testable.
  Adversarial review caught two CRITICALs, both fixed: (1) a 404 on the
  required_status_checks sub-resource is ambiguous (unprotected vs
  protected-without-checks) — collapsing both to create/PUT would have WIPED
  existing reviews/enforce_admins/restrictions, so apply now disambiguates via
  the parent /protection endpoint and only PUT-creates when genuinely
  unprotected (else PATCHes the sub-resource, preserving other protection); (2)
  a wrong check-context registers a phantom required check that blocks EVERY
  merge — so apply now verifies the context against a recent commit's actually-
  reported check runs and refuses (listing the real ones) unless --force. Also
  hardened error handling (401/network/5xx/nonexistent-branch → HardGateBlocked
  playbook, never a traceback). Docs: guide Soft→hard section walks the command
  - both safety rails. 22 new tests, full suite green. (refs:
    agent/guardian/hard_gate.py, cli.py; docs/guides/pr-guardian.md)
- **Blockers:** —
- **Plan:** —

### Wire quality_scorer into the guardian gate

- **Status:** done
- **Spec:** —
- **Summary:** DONE (adversarially reviewed) — the guardian now emits an
  advisory `weak-test` finding for an added test that defines a test function
  but asserts nothing (the "asserts-nothing passes green" gap). New
  quality_scorer.is_assertion_free_test(code, framework) predicate — co-located
  with the assertion/test-fn patterns so it can't drift — requires BOTH a test
  function AND zero assertions (high precision: a snapshot/table-driven test
  matches an assertion pattern and is NOT flagged, per the roadmap's
  trust-erosion risk). pr_check.build_weak_test_findings consumes the test-path
  units filter_test_units already sets aside, scoring only the diff's ADDED
  lines. The finding is LOW/`weak-test` and NEVER gates — compute_exit_code
  gates only `untested-new-code`, so it's advisory by construction (advisory
  first, before any gate promotion). A weak-test-only diff no longer
  short-circuits at "nothing to verify". Config toggle
  canary.guardian.pr.weakTests (default true; non-blocking so on by default).
  Adversarial review confirmed the non-gating guarantee airtight but caught
  precision gaps (the roadmap's trust risk); fixed by broadening assertion
  patterns (chai `.should` / node `assert.equal` / `assert_*` helpers now count
  as asserting) and skipping a rename that adds only a signature line (no added
  body to judge). Residual lexical limits (per-file-blob granularity; a
  non-`assert`-named helper) documented in the guide; advisory-only so the
  escape hatch is the toggle. ~28 new tests, full suite green. Ideation pick
  (score 3.00) from docs/ideation/deepen-core-test-intelligence-2026-07-19.md.
  (refs: agent/core/quality_scorer.py, agent/guardian/pr_check.py, cli.py;
  docs/guides/pr-guardian.md)
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
  low confidence. Next: spike before /harness:brainstorming. LINKED 2026-08-07
  to Issue #486, which is the diff-scoped proposal this deferral was waiting on
  and arrives with the evidence this row lacked (three vacuous tests that passed
  CI against the bug they were written to catch; two hand-run mutants decisive
  on #484). The row and the issue existed for weeks without either being
  reachable from the other. Also note Issue #339's canary-katana checkbox
  described this same work before that name shipped as deleted-test quarantine;
  #339 is now closed and #486 is the sole owner. Status stays backlog — the
  spike is still the next step, this is a link and not a decision.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#486

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

- **Status:** done
- **Spec:** —
- **Summary:** DONE (#381) — shipped as agents/skills/claude-code/canary-katana/
  (SKILL.md + Tier-0 scripts diffscan/ledger/alarm/cli, 66 unit tests).
  Silent-by-default: records every deleted/skipped test to an append-only,
  deduped provenance ledger and alarms only on last-coverage loss of a
  critical-area symbol; degrades to recording-only (never fails, even under
  --strict) when critical-area data is absent. Original ideation: rank 1 (score
  6.75) from docs/ideation/bop-themed-canary-skills-2026-07-21.md. Capture every
  deleted or skipped test with provenance (who, when, what it covered) instead
  of letting it vanish silently, and alarm when a deletion drops the LAST
  coverage on a critical-area symbol. Test deletion is an untracked
  coverage-regression vector. Accepted risk to handle in spec: most deletions
  are legitimate (dead feature removal, genuine dedup), so alarming on every one
  becomes nag fatigue and a muted gate is worse than no gate - ship
  silent-by-default, firing only on last-coverage-of-critical-area.
  Deterministic/Tier-0 (git diff + coverage set math, no LLM). Low effort / high
  confidence. Next: /harness:brainstorming to spec.
- **Blockers:** —
- **Plan:** —

### canary-savant — test order-dependence and isolation detector

- **Status:** done
- **Spec:** docs/changes/canary-savant/proposal.md
- **Summary:** DONE (PRs #405-#408 + Phase 5) — shipped as the FIRST JS/Node
  skill (agents/skills/claude-code/canary-savant/, cli.mjs, requires node>=20),
  establishing the agents/skills vitest test harness + `Skills (JS)` CI job that
  future JS skills reuse (canary mirrors harness, which is Node/TS; see the
  js/ts-going-forward decision). Ideation rank 2 (score 6.75). Two tiers: Tier 1
  static suspect scan (SV001-SV004, always-on, advisory) and Tier 2 opt-in
  dynamic confirmer (`--confirm`) that runs baseline ->
  shuffle-under-pinned-seed -> classify, then for pytest isolates each victim
  and BISECTS the prefix to name the polluter (not just the victim), with a
  reproduce command. pytest + vitest classify; polluter bisect is pytest-only
  (vitest lacks CLI-driven ordered per-test execution). Dogfooded advisory on
  canary's own suite in CI; rule tuning cut the backlog 37 -> 6 (SV002 narrowed
  to class/all-scoped setup, SV004 ordinals must be terminal). Remaining: flip
  the advisory gate to `--strict` once the 6 suspects are triaged. (refs:
  docs/changes/canary-savant/proposal.md; the Python Phase-1 #405 was superseded
  by the JS port #406.)
- **Blockers:** —
- **Plan:** —

### canary-blackhawk — temporal-dependency linter

- **Status:** done
- **Spec:** —
- **Summary:** DONE (#381) — shipped as
  agents/skills/claude-code/canary-blackhawk/ (SKILL.md + Tier-0 scripts
  rules/scanner/cli). Original ideation: rank 3 (score 6.75) from
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
  analysis runs. Next: gap analysis, then /harness:brainstorming. DISAMBIGUATION
  2026-08-07: Issue #340 was titled "Clocktower voices" and is NOT this row — it
  is a product-wide voice/report-theming concern, not a skill. It has been
  retitled off the clocktower name and has its own row below. Note also that the
  gap analysis here depends on Issue #538: nothing currently writes the local
  history store, so part of the gap may already be known.
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
  /harness:brainstorming to spec. NAME COLLISION RESOLVED 2026-08-07: Issue #460
  also claimed `canary-cassandra`, for predictive test ordering — an unrelated
  feature. This row keeps the name (Cassandra Cain reads the fake, which is what
  vacuous-test detection does); #460 was renamed `canary-shiva` and has its own
  row below. The collision was possible because roadmap rows and tracker issues
  both mint Birds of Prey names and neither reads the other.
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

### canary-shiva — predictive test ordering

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #460, and renamed from `canary-cassandra` on 2026-08-07 after the name
  collided with the vacuous-test-detection row above. Lady Shiva reads a fighter
  and anticipates the next move, which is the feature: mine the run-history
  NDJSON plus the PR diff to run likeliest-to-fail tests first, so on a
  multi-hour suite the failure surfaces in minute one rather than hour three.
  Accepted risk to handle in spec: ordering is an OPTIMIZATION, NEVER A FILTER —
  every test still runs, because a predictive ordering that silently drops tests
  is a correctness bug wearing a performance costume. Needs a defined cold-start
  fallback (diff-proximity, then declaration order; never fail) and an explicit
  did-it-help metric (time-to-first-failure vs the unordered baseline) or there
  is no way to know the model earns its complexity. Next: the blocking data
  spike in #460 — per-test pass/fail history, commit keying, retention, and
  whether any supported runner will accept an order.
- **Blockers:** Issue #538 (nothing writes the local history store, so the
  volume/retention question may already have a known answer)
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#460

### canary-rewind — time-travel run debugging

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #461. Reconstruct a past run — env, seed, commit, order, traces — and
  replay a single failed test in that exact context, then diff against the
  nearest green run. The second of the two flagship bets that exploit the
  run-history asset. Accepted risk to handle in spec: "the exact context" is a
  claim the store must actually be able to honor; if seed and order were never
  recorded, replay reproduces a different run while presenting itself as the
  original, which is worse than not offering replay at all. The honest first
  deliverable may be a history-schema change. Note `rewind` is not a Birds of
  Prey name; if the roster convention is meant to hold, this row needs one.
- **Blockers:** Issue #538 (no writer for the local history store)
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#461

### canary-screech — broken-main siren

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #591. Wave 1, small and visible. When the default branch goes red, emit
  a one-page blast: culprit commit range, failure cluster, owning area, a
  quarantine-or-revert recommendation, and a chat-ready block. Distinct from
  canary-fail-fast (in-run, aborts early) and canary-test-reporter (per-run
  summary) — neither looks across runs or knows the branch went red. Open in
  #591: where the branch-is-red signal comes from (Actions webhook, polling, or
  the history store), and whether it posts the blast or only emits it.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#591

### canary-misfit — E2E resilience injection

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #592. Wave 2. Wrap a Playwright run with route-level latency, 5xx
  bursts, aborted responses, and slow-network profiles, then report which flows
  degrade gracefully and which shatter. Injection sits at the Playwright route
  layer so it needs no application changes — the same property that makes
  canary-instrument additive-safe. Accepted risk to handle in spec: the output
  is a per-flow verdict, not a gate; a flow that shatters under a 5xx burst may
  be an accepted risk, and the deliverable is that someone decided. Needs a
  deterministic seed or a reported failure cannot be reproduced.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#592

### canary-mission-briefing — PR diff to human test charter

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #593. Wave 2. Given a diff, produce a plan for a person: what to verify
  manually, which edge cases the diff invites, which existing tests cover it and
  which parts nothing covers. Three skills read a diff and they are not
  interchangeable — canary-pr-guardian emits a gate verdict for CI,
  canary-generate-test emits code for the suite, and this one emits a charter
  for a human tester. It is explicitly not a gate and explicitly not generated
  code, and it is the only one of the three aimed at manual verification. Open
  in #593: whether the coverage half reuses the guardian's Tier-0 diff-coverage
  pass, and whether output is stdout Markdown or a sticky PR comment.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#593

### canary-sweep — site-wide a11y audit

- **Status:** backlog
- **Spec:** —
- **Summary:** Split from the Skill Forge umbrella (Issue #339, now closed) into
  Issue #594. Wave 2. Crawl routes, run axe-core per page, dedupe findings by
  component, and output a WCAG-mapped report with fix snippets. Component-level
  dedup is the load-bearing idea: a per-page axe dump already exists in a dozen
  tools and nobody reads it, and one bad button reported forty times is noise —
  noise is how a11y tooling gets muted. Accepted risk to handle in spec: route
  discovery is framework-specific, and a v1 that claims to discover routes while
  silently missing half is exactly the abstention failure this repo exists to
  prevent; taking an explicit route list is the honest version. Open in #594:
  whether this is in scope for a testing tool at all, or belongs downstream — it
  is the least test-shaped item in the Skill Forge batch.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#594

## Engine and Platform

### Persona system as a first-class engine concept

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #462, split from #340. Audience adaptation is hand-rolled
  per skill today — each re-implements some variant of "if tester, use simpler
  words" — so tone drifts between skills and an overlay cannot override it.
  Replace with a persona definition (audience, technical depth, preferred output
  formats, voice) that skills CONSULT rather than reimplement, extensible by
  downstream overlays through the same `precedence` arbitration the overlay
  contract already defines. Inventory the existing surface first: `canary doctor
  --audience` (renamed from `--persona` in v5.12.0, legacy aliases retained),
  the sdet/tester onboarding tracks, and the tester-facing skills that scale
  run-summary tone. Accepted risk to handle in spec: if the persona is inferred
  rather than configured this collides with Issue #341, and inferring an
  audience wrongly is the failure mode users notice and resent; the no-persona
  fallback must be a real good default, not a degraded mode.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#462

### Voice pack and themable external-report hooks

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #340, retitled 2026-08-07 off the "Clocktower voices" name
  that collided with the canary-clocktower row above. The project has a voice
  identity but it stops at one character in one file. Build out distinct voices
  for the Birds of Prey cast with a small style guide each, use them across
  session responses, report flavor lines, doc epigraphs, and CLI moments, and
  provide the engine-side hook for external-facing reports (a themable footer
  slot plus a clean way for overlays to inject brand styling into HTML output).
  Accepted risk to handle in spec: voice is garnish and never load-bearing —
  every voiced line carries the plain fact too, and a `--no-flavor` off-switch
  must exist for CI logs and formal contexts. Sequencing: voice attaches to a
  persona, so Issue #462 wants to land first or the pack ships unwired. New
  names must not collide with a shipped skill or an existing row — the failure
  this reconciliation just cleaned up; `cassandra` and `clocktower` are spoken
  for and `oracle` is retired and never reused.
- **Blockers:** Issue #462 (personas — voice needs something to attach to)
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#340

### Skill Forge primitives — cross-surface consistency and reachability

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #452. A skill exists across several surfaces at once (the
  SKILL.md, the plugin manifest, the slash command, the agent definition, the
  docs), and nothing checks that those agree or that every declared skill is
  actually reachable. Build the two primitives: a cross-surface consistency
  check and a reachability sweep. Accepted risk to handle in spec: this is
  denominator-shaped work, so the check must report what it could not examine
  rather than passing quietly — a sweep that finds zero unreachable skills
  because it enumerated zero skills is an abstention, not a pass.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#452

### Shared company-knowledge schema and loader package

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #550. `.canary/company.json` — the org pointer file for
  Confluence spaces, Jira projects, internal domains, MCP servers, dashboards,
  and the user-catalog skill — is read by canary-ci-ready and
  canary-failure-impact, each with its own parsing. Extract the schema and
  loader into a shared, tool-neutral package so consumers stop re-deriving it
  and a schema change lands in one place. Enabler work: it unblocks nothing on
  its own but removes a duplicated contract that will drift.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#550

### Overlay workflow templates for consumer repos

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #459. `canary migrate`/`adopt` should install the overlay
  workflow templates into a consumer repo, shape-aware and using portable paths.
  Follows directly from the monorepo-shape work in Issue #504: once the tool
  knows a repo's shape it can install the right workflow rather than one
  template that assumes a single package at the root. Accepted risk to handle in
  spec: writing workflow files into someone else's repo is the highest-blast
  radius thing canary does, so it needs a dry-run plan shown before any write,
  matching the confirm-before-apply flow migrate already uses.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#459

### Gate canary-promote-test on structured test-craft verdicts

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #477. Promotion out of `tests/generated/` into the
  committed suite is currently a review-and-move flow with no machine gate.
  Require a structured verdict from test-craft before a generated test can be
  promoted, so the quality bar is enforced rather than remembered. Accepted risk
  to handle in spec: a gate that blocks promotion needs an abstention path — if
  test-craft cannot form a verdict, that must be reported as unable-to-assess
  and not silently treated as a pass, which is the exact failure class the
  no-silent-abstention work exists to close.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#477

### Measure abandonment, not satisfaction

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #491. Derive passive adoption signals from the analyses
  records — where users stop, which flows are started and never finished, which
  outputs are generated and never used — instead of asking whether people are
  satisfied. Serves the legibility track: abandonment is observable and honest
  where self-reported satisfaction is neither. Accepted risk to handle in spec:
  this is usage telemetry on real users, so what is collected, where it is
  stored, and how it is opted into all belong in the spec rather than the
  implementation, and nothing identifying may land in the records.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#491

### Pedagogical Reasoning Mode

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #342. A mode in which canary explains its reasoning as it
  works — why this framework, why this edge case matters, why this test is weak
  — so the tool teaches rather than only produces. Adjacent to the persona work
  in Issue #462: depth of explanation is one of the axes a persona definition
  would carry, and building this without personas risks hard-coding a second
  audience model beside the first. Accepted risk to handle in spec: explanation
  attached to a wrong answer is more convincing than the wrong answer alone, so
  this raises the cost of a confident-but-incorrect finding.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#342

## Product Surface Gaps

### canary history record — a writer for the local history store

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #538. The local history store has a schema, a store
  abstraction, a local and a Supabase backend, a flake-trend detector, and a
  `canary history` CLI — but no command writes to the local store. The only
  writer is `dogfood-record-run.mjs`, a script. Promote it to a real
  `canary history record` command. This is the product-lies class: the
  capability is documented and the read side exists, so the gap is invisible
  until someone queries an empty store. It also gates real work — the
  canary-shiva and canary-rewind rows above both depend on history having
  content, and the canary-clocktower gap analysis is partly answered by it.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#538

### Uninstall path

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #523. The word "uninstall" appears zero times in README,
  docs/, and source. Canary writes into consumer repos — skills, workflows,
  config, generated tests — and offers no documented way to take it back out.
  Product-lies class, and the one with the clearest reputational cost: a tool
  that cannot be removed cleanly is a tool people hesitate to install. Accepted
  risk to handle in spec: uninstall must distinguish what canary authored from
  what the user has since edited, and must never delete a test someone has come
  to rely on without saying so first.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#523

### doctor — detect a stale Claude Code plugin

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #522. The CLI and the Claude Code plugin version
  independently, so a user can run a current CLI against a stale plugin and get
  behavior from neither. `canary doctor` has no check for this. Tooling-rot
  class: the failure is silent and presents as inexplicable behavior rather than
  as a version problem. Small, well-bounded, and directly serves the
  denominator principle — a doctor that cannot see a whole surface should say
  so.
- **Blockers:** —
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#522

### Consume the detected environment and user-level context

- **Status:** backlog
- **Spec:** —
- **Summary:** Issue #341. Environment and user-level context detection ships
  and works; nothing reads it. Product-lies class in its purest form — the
  feature is present, tested, and inert. Wire the existing detection into the
  consumers that should adapt to it. Accepted risk to handle in spec: the
  SDET-vs-manual detection half collides with the persona work in Issue #462 and
  needs its own design default, because inferring a user's skill level wrongly
  is the failure people resent; decide there whether detection proposes or
  decides.
- **Blockers:** Issue #462 (persona definition — overlapping audience model)
- **Plan:** —
- **Assignee:** —
- **Priority:** —
- **External-ID:** github:bop-clocktower/canary#341
