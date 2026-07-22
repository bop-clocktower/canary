---
topic:
  Birds-of-Prey-themed canary skills for test-quality hardening, richer
  reporting, dev reward, QA visibility, and everyday fun
generated_at: 2026-07-21T21:28:28Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 14
count_generated: 14
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

# Ideation: Birds-of-Prey-themed canary skills

## Inputs

- Topic: BoP-themed canary skills serving five goals — harden test quality,
  richer reporting, reward sound engineering, amplify QA visibility, add fun.
  Constraint: the theme is a wrapper, never the substance; pure renames and
  cosmetic-only candidates were rejected at generation time.
- Generated: 2026-07-21T21:28:28Z
- Strategy grounding: enabled — STRATEGY.md v2 (5 tracks). Track 5 ("Quality
  made legible") was added mid-run at user request; `canary-signal` and
  `canary-manhunter` were re-scored upward on impact as a result.
- Objections: user elected `none` — all critiques stand as accepted downsides.

## Naming decisions made before generation

- **Oracle is burned.** Barbara Gordon is the best thematic fit for the
  information-broker role, but `Oracle` was this project's pre-rename identity.
  Reusing it would resurrect a retired name. The role went to
  `canary-clocktower`.
- **Gypsy is excluded.** The character name is an ethnic slur and DC has moved
  away from it. Her thematic job (camouflage → de-identified test fixtures) is
  real but did not place in the top 14 on merit.
- **Misfit is a name, not a candidate.** Teleporting between pass and fail is an
  ideal flake metaphor, but the roadmap already carries "Flakiness detector
  skill over test-reporter history". Take the name for that item; it is not a
  new idea.

## Ranked candidates

### 1. canary-katana — deleted-test quarantine (Soultaker) — score: 6.75

- Persona: engineer mid-development
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25 target
  problem — final score 6.75
- Premise: capture every deleted or skipped test with provenance (who, when,
  what it covered) instead of letting it vanish, and alarm when a deletion drops
  the last coverage on a critical path.
- Strongest objection: most test deletions are legitimate — dead feature
  removal, genuine dedup — so alarming on every one becomes nag fatigue within a
  week, and a gate people mute is worse than no gate. Survives only if silent by
  default, firing solely when the deleted test was the last coverage of a
  critical-area symbol.
- Objection answered: no — accepted downside.

### 2. canary-savant — order-dependence and isolation detector — score: 6.75

- Persona: engineer mid-development
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Test intelligence depth, +0.25 target problem —
  final score 6.75
- Premise: shuffle and run-alone-repeat the suite to surface tests that only
  pass in a specific order, exposing shared-state leakage.
- Strongest objection: test-isolation work shipped in v5.11.0 already, so this
  may be re-solving a solved problem under a new name — the exact
  rename-not-idea failure this batch was meant to reject. Holds only if the
  prior work was canary's own suite hygiene rather than a user-facing
  capability. FLAGGED FOR HUMAN VERIFICATION, not resolved.
- Objection answered: no — accepted downside, verification pending.

### 3. canary-blackhawk — temporal-dependency linter (Zinda) — score: 6.75

- Persona: engineer mid-development
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Test intelligence depth, +0.25 target problem —
  final score 6.75
- Premise: statically flag tests depending on wall-clock, timezone, or DST — the
  ones that pass all day and fail at midnight or on the leap.
- Strongest objection: frozen-clock idioms differ per framework
  (`vi.useFakeTimers`, `freezegun`, `jest.setSystemTime`), so a naive AST rule
  false-positives on tests that already handle time correctly. Addressable — the
  framework registry already knows the framework, so the rule can be
  framework-conditioned rather than universal.
- Objection answered: no — accepted downside (mitigation noted).

### 4. canary-signal — QA impact digest (the Bat-signal) — score: 6.75

- Persona: client-success and delivery staff
- Complexity: low
- Impact / Confidence / Effort: H/M/L — base score 6.00 (raised from 4.00 when
  STRATEGY.md v2 added track 5)
- Strategy alignment: +0.5 track:Quality made legible, +0.25 persona — final
  score 6.75
- Premise: broadcast a periodic digest of what testing actually caught — bugs
  prevented, sweeps run, escapes avoided — to Slack, Teams, or a PR comment.
- Strongest objection: without `canary-clocktower` it can only describe the
  latest run, which undersells QA and actively inverts the goal — a digest
  reading "1 run, 0 escapes" says "QA did nothing this week". Hard-blocked on
  candidate 5; shipping it first would be worse than not shipping it.
- Objection answered: no — accepted downside. Sequencing dependency is firm.

### 5. canary-clocktower — persistent run-history substrate — score: 5.25

- Persona: client-success and delivery staff
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:Quality made legible, +0.25 persona — final
  score 5.25
- Premise: a durable store and query API over canary-test-reporter run
  artifacts, which are stateless and ephemeral today.
- Strongest objection: canary is proudly stateless and secret-free; a datastore
  adds retention, PII, and ops burden to a CLI, forcing every adopter to answer
  "where does this live, who prunes it, is there customer data in a failure
  message?" — friction opposing the Adoption and onboarding track. Dissolves
  only if it ships as a local, opt-in, single-file store (the YAML+SQLite TCM
  precedent) with no server.
- Objection answered: no — accepted downside.
- NOTE: load-bearing. Unblocks candidates 4 (signal), 13 (hawk-dove), 14
  (batgirl's non-fakeable metrics), and the existing roadmap flakiness-detector
  item, which defers explicitly because "historical run JSON is not persisted
  anywhere today".

### 6. canary-manhunter — release quality dossier — score: 5.25

- Persona: client-success and delivery staff
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50 (raised from 3.00 when
  STRATEGY.md v2 added track 5)
- Strategy alignment: +0.5 track:Quality made legible, +0.25 persona — final
  score 5.25
- Premise: assemble the full evidentiary case for a release — coverage tiers,
  guardian findings, sweep results, escape history — into one signed report.
- Strongest objection: reporting with no decision attached is theater, becoming
  a beautiful PDF nobody opens; this is the most common way quality tooling
  dies. Survives only if the dossier gates something real or answers a question
  someone is already asking under time pressure.
- Objection answered: no — accepted downside.

### 7. canary-cassandra — vacuous-test detection — score: 3.00

- Persona: engineer mid-development
- Complexity: high
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Test intelligence depth, +0.25 target problem
  (recorded; outside tie window, no rank effect) — final score 3.00
- Premise: diff execution traces from canary-instrument's OTel against each
  test's declared target to find tests that pass without ever invoking the code
  they claim to cover.
- Strongest objection: "declared target" is not declared anywhere and must be
  inferred from test names and imports — precisely the heuristic tier the
  strategy exists to distrust. Failure mode: confidently flagging a correct
  integration test as vacuous because the call sits three frames deeper than it
  looked. Needs an explicit `@covers` annotation or trace-to-symbol resolution
  good enough to earn `graph-verified` rather than `heuristic`.
- Objection answered: no — accepted downside.
- NOTE: addresses the STRATEGY.md target problem most directly of any candidate;
  its low rank is driven by effort and confidence, not by relevance.

### 8. canary-question — test-bug vs product-bug triage — score: 3.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Test intelligence depth (recorded; no rank
  effect) — final score 3.00
- Premise: interrogate a failure and classify it as a false-fail (test defect)
  or a real SUT defect, showing its reasoning.
- Strongest objection: a wrong triage is worse than no triage — "it's just a
  flaky test" stamped on a genuine product bug is exactly the mechanism by which
  defects escape, degrading the headline escaped-defect metric while appearing
  to help. Only addressable if it never emits a confident verdict: a
  fidelity-labeled hypothesis with evidence, never a disposition.
- Objection answered: no — accepted downside.

### 9. canary-judomaster — incident to regression test — score: 3.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 key metric
  (escaped-defect ratio) (recorded; no rank effect) — final score 3.00
- Premise: turn a production failure — stack trace, repro, incident record —
  into a failing regression test that pins the defect.
- Strongest objection: it needs structured incident input most orgs lack in
  machine-readable form; in practice you get a Slack thread and a screenshot,
  not a stack trace with state. Works beautifully in the demo, then sits unused
  because nobody's incidents match the input contract. Needs a degraded path
  accepting a pasted stack trace alone.
- Objection answered: no — accepted downside.

### 10. canary-ivy — suite overgrowth and pruning — score: 2.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Test intelligence depth (recorded; no rank
  effect) — final score 2.00
- Premise: detect metastasized suites — duplicated fixtures, tests covering
  nothing not already covered, and runtime creep over time.
- Strongest objection: recommending test deletion is the most dangerous advice a
  test tool can give — a "redundant by coverage" test may be the only one
  asserting the behavior that breaks, since line coverage does not capture
  assertion intent. Directly contradicts the STRATEGY.md target problem, which
  holds that coverage overlap does not equal equivalent proof.
- Objection answered: no — accepted downside. This objection is severe enough to
  warrant reshaping the premise before any spec.

### 11. canary-harley — property-based and fuzz test generation — score: 2.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Test intelligence depth (recorded; no rank
  effect) — final score 2.00
- Premise: generate property-based tests (fast-check, Hypothesis) with
  shrinking, rather than example-based cases.
- Strongest objection: property-based testing needs an invariant, and
  articulating the invariant is the entire hard part — generating framework
  boilerplate around a weak or wrong property produces confident nonsense that
  shrinks to a meaningless minimal case. Worth it only if the real output is a
  proposed invariant the human confirms.
- Objection answered: no — accepted downside.

### 12. canary-huntress — targeted regression pursuit — score: 2.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Pre-release confidence (recorded; no rank
  effect) — final score 2.00
- Premise: hunt one specific defect class across the entire suite and its
  history, rather than exploring broadly.
- Strongest objection: `git bisect` already finds when a regression entered and
  `canary-cry` explores broadly, so the remaining slice — find every other place
  this same bug shape exists — may be too narrow to justify a skill rather than
  a flag on an existing one. This is a reserved name looking for a job, which is
  the wrong direction of fit.
- Objection answered: no — accepted downside.
- NOTE: `canary-huntress` is a previously reserved name (2026-07-21). This
  candidate is the first attempt to give it a scope and does not yet clear the
  bar.

### 13. canary-hawk-dove — gate threshold auto-tuner — score: 1.00

- Persona: engineer mid-development
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: +0.5 track:Test intelligence depth (recorded; no rank
  effect) — final score 1.00
- Premise: balance aggression against noise by tuning gate thresholds from the
  historical false-positive versus escaped-defect record.
- Strongest objection: it requires ground-truth labels on past findings — was
  this finding real? — that nobody records; without them it tunes on noise and
  produces a confidently wrong threshold. Blocked behind both
  `canary-clocktower` and a labeling ritual humans will not perform.
- Objection answered: no — accepted downside.

### 14. canary-batgirl — developer and team quality scorecard — score: 1.00

- Persona: engineer mid-development
- Complexity: medium
- Impact / Confidence / Effort: M/L/M — base score 1.00
- Strategy alignment: +0.5 track:Quality made legible (recorded; no rank effect)
  — final score 1.00
- Premise: streaks, badges, and rank derived from canary audit scores, rewarding
  sound and stable code.
- Strongest objection (sharpest in this batch): Goodhart's law points this
  weapon directly at the project. Scoring engineers on canary metrics makes them
  optimize the score, and the cheapest way to raise almost any coverage-derived
  score is to write more assertion-free tests — meaning the reward system would
  actively manufacture the STRATEGY.md target problem. Safe only if it scores
  things expensive to fake (escaped-defect ratio, coverage-verified share) and
  never anything a developer can inflate by adding green.
- Objection answered: no — accepted downside. Track 5 legitimizes the goal but
  does not resolve this objection, which is why confidence stays low.

## Observations

- **The four top candidates are all low-effort, high-confidence, and
  deterministic** (katana, savant, blackhawk, signal). Three of them are
  Tier-0-friendly static or mechanical analyses requiring no LLM, consistent
  with the STRATEGY.md second bet.
- **The alignment tiebreaker was inert this run.** Every candidate inside the
  6.00 and 4.50 tie windows earned the same +0.75, so no rank order changed. The
  bonus is recorded for transparency per the scoring contract.
- **Sequencing constraint:** `canary-clocktower` (5) gates `canary-signal` (4),
  `canary-hawk-dove` (13), and the non-fakeable half of `canary-batgirl` (14).
  Despite ranking 5th, it should likely be built first among that cluster.
- **Two candidates carry objections severe enough to reshape the premise before
  speccing:** `canary-ivy` (10) recommends deletion in a way that contradicts
  the target problem, and `canary-batgirl` (14) risks manufacturing it.
