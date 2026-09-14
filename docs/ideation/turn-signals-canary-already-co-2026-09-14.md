---
topic:
  Turn signals canary already computes into gate-consumable findings —
  quality_scorer, flake detection, generated-test soundness
generated_at: 2026-09-14T01:58:30Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 10
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Turn signals canary already computes into gate-consumable findings

## Inputs

- Topic: Turn signals canary already computes into gate-consumable findings —
  quality_scorer, flake detection, generated-test soundness
- Generated: 2026-09-14T01:58:30Z
- Strategy grounding: enabled — `STRATEGY.md` present and valid (v2,
  last_updated 2026-07-21). This topic is verbatim STRATEGY.md track 2 ("Test
  intelligence depth").

## Method

Candidates were grounded in a live survey of the shipped surface rather than
generated from first principles, and deliberately steered PAST the work this
track has already absorbed. Surveyed: `ts/src/core/quality-scorer.ts` (scores
coverage breadth, assertion density, flakiness risk, magic numbers — of which
only `isAssertionFreeTest` has a consumer), `ts/src/core/static-linter.ts`
(overlapping flakiness regexes under its own rule vocabulary),
`ts/src/history/detector.ts` (`classifyFlakeTrend`, `detectRegressions` — pure
functions with no PR-time consumer), `ts/src/guardian/weak-test.ts` (the one
scorer signal that did reach the gate, advisory), `ts/src/guardian/pr-check.ts`
(finding kinds today: `untested-new-code`, `coverage-regression`, `weak-test`),
`ts/src/guardian/adjudication.ts` (precision collected whole-comment, so
per-kind precision is unknowable), and `ts/src/guardian/hard-gate.ts`.

Dedup pass: `docs/ideation/deepen-core-test-intelligence-2026-07-19.md`,
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`, and ~56
`docs/roadmap.md` entries were read first. Ideas already owned by an existing
row — the flakiness detector skill (`canary-misfit`), the generated-test
soundness linter, guardian coverage-delta, Stryker mutation, `canary-cassandra`,
`canary-signal`, the `canary history record` writer (#538), and the test-craft
promotion gate (#477) — were excluded rather than restated. The recurring shape
the survey exposed, and the one most candidates attack, is structural rather
than analytical: canary computes more signal than its gate has any vocabulary to
carry.

All ten objections stand as accepted downsides (the operator elected to rebut
none). Each is recorded below as an implementation-time risk to verify, not a
rebutted concern.

## Ranked candidates

### 1. A signal-consumption ledger test — every dimension canary computes is either wired to a named surface or declared unconsumed — score: 6.75

- Candidate #4 (generation order)
- Persona: the maintainer deciding what to build next in this track, who
  currently has no inventory of which computed signals already reach a reader.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 approach
  (zero-denominator honesty, "degrades loudly rather than silently guessing") —
  final score 6.75
- Strongest objection: a ledger is bookkeeping, not capability — it ships no new
  finding and no user-visible behaviour, so it competes for a slot against items
  that do. Most likely failure mode: the ledger is authored once, every current
  gap is annotated `unconsumed: intentional` to make it green on day one, and it
  then rots into a second source of truth that disagrees with the code — exactly
  the drift class canary exists to catch, committed by canary. For the objection
  not to hold, the ledger must be DERIVED (enumerate scorer/linter/detector
  exports mechanically and fail on an undeclared one) rather than hand-listed,
  and an `unconsumed` declaration must carry a reason string that a reviewer can
  reject.
- Objection answered: no — accepted.

### 2. Gate-input availability preflight — distinguish "no findings" from "no inputs" — score: 6.75

- Candidate #6 (generation order)
- Persona: the engineer mid-development reading a green guardian comment, who
  cannot tell whether the flake and quality signals ran or were simply
  unavailable.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 approach
  ("degrades loudly when the evidence tier drops") — final score 6.75
- Strongest objection: `pr-check.ts` already encodes this discipline for
  coverage (#554's "a blind run never claims clean"), so a second, generalized
  preflight risks being a refactor wearing a feature's clothes, and a
  per-producer availability line lengthens the sticky comment that reviewers
  already skim. Most likely failure mode: the availability block becomes a
  permanent wall of "history store: empty" for every repo that has not run
  `canary history record` (#538), and readers learn to skip the header — which
  costs the coverage warning its existing weight. For the objection not to hold,
  the preflight must extend the existing #554 seam rather than add a parallel
  one, and must render only DEGRADED inputs, never a roll-call of healthy ones.
- Objection answered: no — accepted.

### 3. One rule-ID registry across quality-scorer, static-linter, blackhawk and savant — score: 6.50

- Candidate #8 (generation order)
- Persona: the engineer who gets the same sleep-in-a-test flagged twice under
  two different names and cannot suppress, track, or count it as one thing.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:"Test intelligence depth" — final score 6.50
- Strongest objection: this is the "three overlapping half-enforcers" risk that
  the 2026-07-19 artifact already recorded against the soundness-linter row,
  promoted to its own deliverable — and a registry that unifies IDs without
  unifying the DETECTORS leaves the duplicate regexes in place, so the same
  string is still matched twice and only the label agrees. Most likely failure
  mode: a stable ID is minted for each existing rule, the registry is declared
  done, and the genuine consolidation (one flakiness detector with one
  precision) never happens because the symptom stopped showing. For the
  objection not to hold, the registry needs a test asserting no two registered
  rules share a detection pattern, so an overlap is a failure rather than two
  well-named rows.
- Objection answered: no — accepted.

### 4. A finding-producer contract — any analyser can emit a fidelity-labeled GuardianFinding — score: 5.25

- Candidate #1 (generation order)
- Persona: the author of an advisory skill (cassandra, blackhawk, savant, the
  static linter) whose output is real analysis that no gate surface can read.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 approach
  ("fidelity-labeled evidence over verdicts", auditable provenance) — final
  score 5.25
- Strongest objection: a producer contract generalizes from three finding kinds
  (`untested-new-code`, `coverage-regression`, `weak-test`), which is too small
  a sample to know which fields are essential — and freezing the schema now
  blesses whatever `GuardianFinding` accidentally became, the same
  warts-blessing risk the coverage-json producer contract carried in track 1.
  Most likely failure mode: the contract fits coverage-shaped findings (a path,
  a line range, an uncovered-lines list) and a temporal or order-dependence
  finding, which is about a RELATIONSHIP between tests rather than a span of
  lines, is forced into a file:line shape that misrepresents it. For the
  objection not to hold, at least one non-span-shaped producer must be modelled
  before the schema is published, and it must ship `version: 1` with
  additive-safe evolution.
- Objection answered: no — accepted.

### 5. A per-kind finding-count ratchet — new advisory violations fail the build before the gate ever blocks — score: 5.25

- Candidate #10 (generation order)
- Persona: the maintainer who has an accurate advisory signal, a backlog too
  large to fix, and therefore no path from advisory to gate.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 target problem
  ("suites then decay silently") — final score 5.25
- Strongest objection: a ratchet converts a false positive from an annoyance
  into a merge blocker without ever having measured the finding's precision — it
  gates on the DELTA rather than the verdict, which sounds safer but means one
  mis-flagged legitimate table-driven test blocks a PR just as hard as a real
  one, with no adjudication record to appeal to. Most likely failure mode: the
  baseline is refreshed to unblock an urgent merge, once, and then routinely —
  and a ratchet that is regularly rebaselined is a ratchet that measures
  nothing, the exact false-green shape canary's own entropy ratchet was built to
  resist. For the objection not to hold, a baseline bump must be a visible,
  reviewed diff with a reason, and the ratchet should only be offered for kinds
  whose measured precision already clears a stated floor.
- Objection answered: no — accepted.

### 6. Per-kind precision ledger and a documented advisory→warn→block promotion ladder — score: 3.75

- Candidate #2 (generation order)
- Persona: the maintainer who wants to promote one accurate finding kind to
  blocking without betting the gate's credibility on the least accurate one.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 approach
  (auditable provenance as the precondition for gating) — final score 3.75
- Strongest objection: `adjudication.ts` deliberately chose whole-comment
  granularity because per-finding comments are a worse artifact, and attributing
  a single 👍/👎 across N findings to one KIND is an inference the reaction data
  cannot support — splitting a small, self-selected sample by kind produces
  several denominators too thin to mean anything, each of which will nonetheless
  be rendered as a number. Most likely failure mode: a kind shows 3/3 true
  positives, clears the ladder's floor, gets promoted to blocking, and the
  fourth through twentieth findings reveal it was never that precise. For the
  objection not to hold, per-kind precision must state its sample size
  everywhere it is rendered, must return `null` rather than 100% below a minimum
  n, and the ladder must require a sample floor and not merely a ratio.
- Objection answered: no — accepted.

### 7. A PR-time flake finding — flag when a PR touches a test history already knows is unstable — score: 3.75

- Candidate #3 (generation order)
- Persona: the reviewer approving a change to a test that has been alternating
  pass/fail for three weeks, with nothing on the PR saying so.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 target problem
  (silent decay surfacing only at a launch) — final score 3.75
- Strongest objection: this consumes a store that, per Issue #538, nothing
  currently writes — so for every repo today the finding would silently never
  fire, and a gate input that is structurally empty is indistinguishable from a
  clean bill of health. Most likely failure mode: it ships, reads as working
  because the guardian stays green, and the first real signal arrives months
  later when a writer lands — with no one having noticed the interim silence.
  Beyond that, `detector.ts` classifies a flake TREND over a test's history,
  which is not the same question as "is this specific touched test flaky right
  now", so the existing function may not be the one this needs. For the
  objection not to hold, #538's writer must land first, and an empty or
  too-short history must render as INSUFFICIENT HISTORY on the PR rather than as
  no finding.
- Objection answered: no — accepted.

### 8. A uniform, expiring, audited waiver vocabulary for every finding kind — score: 3.50

- Candidate #9 (generation order)
- Persona: the engineer with one legitimately unusual test who today can either
  suppress `untested-new-code` or turn the whole gate off, with nothing in
  between for the newer kinds.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: +0.5 track:"Test intelligence depth" — final score 3.50
- Strongest objection: a waiver channel is a suppression channel, and the
  measured outcome of shipping one is usually a codebase quietly papered with
  waivers whose reasons nobody reads — which converts a loud finding into an
  invisible one and is strictly worse than an advisory finding that at least
  still prints. Most likely failure mode: expiry is implemented, the first wave
  expires en masse during a release week, and expiry is disabled or the dates
  are bulk-extended — after which the waivers are permanent and the expiry
  mechanism is decoration. For the objection not to hold, waived findings must
  stay COUNTED and reported as waived (never subtracted into a clean number),
  and expiry must be enforced by a check that cannot be bulk-extended without a
  reviewed diff.
- Objection answered: no — accepted.

### 9. Generation-time falsification probe — plant one mutant at the target and reject a generated test that still passes — score: 1.75

- Candidate #5 (generation order)
- Persona: the engineer accepting a generated test, who has no evidence it would
  fail if the code under test were wrong.
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 target problem
  ("test suites that pass without proving anything") — final score 1.75
- Strongest objection: this is mutation testing with the CI cost objection
  narrowed away rather than solved — one mutant at one site instead of a full
  run — but narrowing the scope also narrows the evidence, and a test that
  survives a single arbitrary mutant has proven almost nothing about the other
  ways the unit can be wrong, while the PASS reads to the user as a soundness
  guarantee. Most likely failure mode: mutant selection is where all the
  difficulty actually lives; an unreachable or semantically-equivalent mutant
  yields a false rejection of a perfectly good generated test, and the feature
  is switched off after the second one. It also requires executing the SUT
  during generation, which the deterministic Tier-0 posture does not currently
  assume, and it is adjacent enough to Issue #486's diff-scoped mutation
  proposal that the two must be reconciled before either is built. For the
  objection not to hold, a defensible mutant-selection strategy must exist and
  the result must be labeled as one-mutant evidence, never as soundness.
- Objection answered: no — accepted.

### 10. Trace-backed assertion relevance — upgrade weak-test from lexical to graph-verified using instrument's OTel run.json — score: 1.75

- Candidate #7 (generation order)
- Persona: the reviewer trusting a green `weak-test` result on a test that does
  assert — on something entirely unrelated to the unit the PR changed.
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: +0.5 track:"Test intelligence depth" +0.25 approach
  (raising a finding from heuristic to graph-verified fidelity) — final score
  1.75
- Strongest objection: "the assertion is about the changed unit" requires
  relating an assertion's observed value back to a symbol through arbitrary
  intervening frames, which is materially harder than the invocation question
  `canary-cassandra` already owns and will confidently mislabel a correct
  integration test whose effect surfaces several layers away. Most likely
  failure mode: it lands in the heuristic tier it was built to escape, now with
  a trace-derived veneer that makes the label MORE credible than the inference
  beneath it — a fidelity claim canary has not earned is worse than an honest
  heuristic one. It also requires an instrument run.json that most consumers do
  not produce, so the realistic outcome is an always-abstaining finding. For the
  objection not to hold, the cassandra work should land first and demonstrate
  trace-to-symbol resolution good enough to earn the graph-verified tier at all.
- Objection answered: no — accepted.

## Combined final ranking (10 candidates)

| Rank | Score | Candidate                                       |
| ---- | ----- | ----------------------------------------------- |
| 1    | 6.75  | #4 Signal-consumption ledger test               |
| 2    | 6.75  | #6 Gate-input availability preflight            |
| 3    | 6.50  | #8 One rule-ID registry across the enforcers    |
| 4    | 5.25  | #1 Finding-producer contract                    |
| 5    | 5.25  | #10 Per-kind finding-count ratchet              |
| 6    | 3.75  | #2 Per-kind precision ledger + promotion ladder |
| 7    | 3.75  | #3 PR-time flake finding from history           |
| 8    | 3.50  | #9 Expiring, audited waiver vocabulary          |
| 9    | 1.75  | #5 Generation-time falsification probe          |
| 10   | 1.75  | #7 Trace-backed assertion relevance             |

Tiebreaker note: every pair in this batch is either an exact base-score tie (|Δ|
= 0, inside the ≤ 0.05 window, so the bounded alignment bonus applies and
resolves order — stable on generation order where the bonus also ties) or
separated by ≥ 0.5 (outside the window, so the bonus is recorded for
transparency and does not reorder). No bonus crosses a base-score group
boundary.

## Handoff

Ideation artifact written:
`docs/ideation/turn-signals-canary-already-co-2026-09-14.md` Top pick: #4 A
signal-consumption ledger test — every dimension canary computes is either wired
to a named surface or declared unconsumed — score 6.75 Next: invoke
`/harness:brainstorming <feature>` to take a candidate into a spec, OR
`/harness:roadmap` to enqueue picks for later.
