---
topic:
  Deepen canary's core test-intelligence — coverage analysis, test-generation
  quality, and guardian follow-through — now that adoption/UX hardening has
  shipped
generated_at: 2026-07-19T12:44:52Z
strategy_grounded: false
strategy_path: null
count_requested: 10
count_generated: 10
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Deepen canary's core test-intelligence

## Inputs

- Topic: Deepen canary's core test-intelligence — coverage analysis,
  test-generation quality, and guardian follow-through — now that adoption/UX
  hardening has shipped
- Generated: 2026-07-19T12:44:52Z
- Strategy grounding: disabled — STRATEGY.md not present at repo root (ranking
  uses impact × confidence ÷ effort only; no strategy-alignment tiebreaker)

## Method

Candidates were grounded in a live survey of canary's test-intelligence surface
rather than generated from first principles: (1) `agent/guardian/coverage.py`
fidelity tiers and format support, (2) `agent/core/quality_scorer.py` scoring
dimensions vs. what the guardian gate actually consumes, (3)
`agent/frameworks/registry.json` breadth (21 frameworks) vs. depth, (4) the
skill catalog for test-intelligence composition seams. Every candidate traces to
a concrete finding: e.g. `coverage.py:186` falls through on Cobertura
`coverage.xml`; `quality_scorer` scores assertions/flakiness but that signal is
not wired into the guardian gate; `delta_emitter.py` exists but
coverage-regression is not surfaced.

All ten objections were accepted as known downsides (user elected `none` to
answer) — each is recorded below as an implementation-time risk to verify, not a
rebutted concern.

## Ranked candidates

### 1. Cobertura XML coverage parser for the guardian coverage-verified tier — score: 6.00

- Candidate #1 (generation order)
- Persona: teams on Java/.NET/JS-Istanbul pipelines that emit `coverage.xml`,
  currently dropped to the graph/heuristic tier.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none (STRATEGY.md absent) — final score 6.00
- Strongest objection: Cobertura is not one format — Jacoco-cobertura and
  Istanbul-cobertura differ in DTD and rate attributes; a parser that reads one
  dialect and silently mis-reads another is worse than the current honest
  fall-through.
- Objection answered: no — accepted; will pin to a named dialect and reject
  unrecognized shapes loudly rather than guess.

### 2. Framework-registry depth audit + honest capability tiers — score: 6.00

- Candidate #4 (generation order)
- Persona: prospective adopter who trusts "21 frameworks" and hits a name-only
  stub.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Strongest objection: a point-in-time capability matrix rots the instant a
  framework is touched; without a test asserting the matrix matches reality it
  becomes drift-bait — ironic for canary.
- Objection answered: no — accepted; will pair the matrix with a coverage test
  that derives tiers from the registry rather than hand-maintaining prose.

### 3. Coverage-json producer contract doc + validator — score: 6.00

- Candidate #8 (generation order)
- Persona: tool author who wants to emit canary-consumable coverage from a
  non-lcov producer.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: none — final score 6.00
- Strongest objection: documenting the format around today's accidental shape
  blesses its warts; a spec written now freezes whatever is under-specified.
- Objection answered: no — accepted; will do a minimal shape review before
  publishing the contract, framed as `version: 1` with additive-safe evolution
  (mirrors the test-reporter/instrument contracts).

### 4. Guardian hard-gate rollout automation — required-check registration + operator playbook — score: 4.00

- Candidate #10 (generation order)
- Persona: maintainer ready to flip guardian soft→hard but stuck on GitHub
  branch-protection wiring.
- Complexity: medium
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: none — final score 4.00
- Strongest objection: required-checks need admin scope and vary across GH
  Free/Team/Enterprise; automation that works on one plan silently no-ops on
  another.
- Objection answered: no — accepted; will detect plan/permission and fail loud
  with a manual-steps fallback rather than pretend success (consistent with the
  "fail-loud" pattern shipped in #294/#295).

### 5. Wire quality_scorer into the guardian gate — flag weak added tests, not just absent ones — score: 3.00

- Candidate #2 (generation order)
- Persona: reviewer who gets a green guardian on an added test that asserts
  nothing.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: a weak-test heuristic that fires on legitimate
  table-driven or snapshot tests erodes trust fast — the entire point of
  guardian's fidelity labeling was to avoid crying wolf.
- Objection answered: no — accepted; will ship as an advisory (non-blocking)
  fidelity-labeled finding first with a conservative high-precision threshold
  before any gate promotion.

### 6. Flakiness detector skill over canary-test-reporter run history — score: 3.00

- Candidate #3 (generation order)
- Persona: QA lead chasing intermittent CI reds across many runs.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: the input (historical run JSON) is not persisted anywhere
  today, so a v1 detector has no data; real value depends on a separate, larger
  storage/ingest step.
- Objection answered: no — accepted; will scope v1 to consume a caller-supplied
  set of run artifacts (stateless) and defer any persistence tier — validates
  the analysis before investing in storage.

### 7. Generated-test soundness linter — reject non-deterministic pins / unpinned numeric contracts — score: 3.00

- Candidate #6 (generation order)
- Persona: user trusting a generated test that is silently flaky or unsound.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: `static_linter.py` and `quality_scorer.py` already exist;
  a third linter risks three overlapping half-enforcers instead of one coherent
  gate.
- Objection answered: no — accepted; will extend the existing linter/scorer
  rather than add a new module, encoding the realworld S4 numeric-contract
  soundness rule as a new rule in-place.

### 8. Guardian coverage-delta — flag coverage regression on touched units vs base — score: 3.00

- Candidate #9 (generation order)
- Persona: reviewer who cannot currently see a PR quietly lowering coverage on
  the lines it touched.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: none — final score 3.00
- Strongest objection: requires a base-branch coverage artifact; most CI only
  uploads head coverage, so the delta is unknowable without a consumer-side
  pipeline change.
- Objection answered: no — accepted; will degrade to "delta unavailable —
  head-only" with a loud note when no base artifact is present, reusing the
  existing `delta_emitter.py` seam.

### 9. Edge-case-discovery → generate-test handoff wiring — score: 2.00

- Candidate #7 (generation order)
- Persona: user who runs `canary-edge-case-discovery` then re-describes the
  findings by hand to `canary-generate-test`.
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: none — final score 2.00
- Strongest objection: the separation may be intentional — discovery is
  exploratory, generation is committal — and collapsing the handoff could remove
  a load-bearing human review beat.
- Objection answered: no — accepted; will wire the handoff as an explicit,
  human-confirmed pass-through (discovery emits a structured artifact the user
  reviews before generation consumes it) rather than an automatic pipe.

### 10. Mutation-testing signal via Stryker (already registered) — score: 1.00

- Candidate #5 (generation order)
- Persona: team with high line-coverage but low real coverage (assertions that
  don't kill mutants).
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: none — final score 1.00
- Strongest objection: Stryker on every PR is minutes-to-tens-of-minutes;
  without incremental diff-scoped mutation it is DOA in CI, and incremental
  mutation is itself a hard problem.
- Objection answered: no — accepted; deferred as the lowest-ranked stretch idea
  — revisit only if diff-scoped mutation proves tractable as a separate spike.

## Combined final ranking (10 candidates)

| Rank | Score | Candidate                                            |
| ---- | ----- | ---------------------------------------------------- |
| 1    | 6.00  | #1 Cobertura XML coverage parser                     |
| 2    | 6.00  | #4 Framework-registry depth audit + capability tiers |
| 3    | 6.00  | #8 Coverage-json producer contract doc + validator   |
| 4    | 4.00  | #10 Guardian hard-gate rollout automation            |
| 5    | 3.00  | #2 Wire quality_scorer into the guardian gate        |
| 6    | 3.00  | #3 Flakiness detector skill                          |
| 7    | 3.00  | #6 Generated-test soundness linter                   |
| 8    | 3.00  | #9 Guardian coverage-delta                           |
| 9    | 2.00  | #7 Edge-case-discovery → generate-test wiring        |
| 10   | 1.00  | #5 Mutation-testing signal via Stryker               |

## Handoff

Ideation artifact written:
`docs/ideation/deepen-core-test-intelligence-2026-07-19.md` Top pick: #1
Cobertura XML coverage parser for the guardian coverage-verified tier — score
6.00 Next: invoke `/harness:brainstorming <feature>` to take a candidate into a
spec, OR `/harness:roadmap` to enqueue picks for later.
