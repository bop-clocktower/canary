---
topic: Adversarial exploration ahead of launches, client onboardings, and demos
generated_at: 2026-09-14T02:02:51Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 9
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Adversarial exploration ahead of launches, client onboardings, and demos

## Inputs

- Topic: Adversarial exploration ahead of launches, client onboardings, and
  demos (STRATEGY.md track 4, "Pre-release confidence").
- Generated: 2026-09-14T02:02:51Z
- Strategy grounding: enabled — STRATEGY.md v2 (5 tracks), read via
  `read_strategy` and returned `{ present: true, valid: true }`.
- Count: 10 requested, **9 generated**. The tenth was cut rather than padded: a
  "release-to-release evidence delta" candidate was generated and then dropped
  because a reviewer would reasonably read it as section one of
  `canary-manhunter`'s release dossier (#611) rather than a distinct idea. Per
  the skill's gate, fewer-but-distinct beats more-but-redundant.
- Objections: user elected to leave every objection standing — all nine
  critiques are on the record as accepted downsides. No rebuttals were authored.

## The tension this track sits on

STRATEGY.md's third approach bet is explicit: _"meet the engineer during
development rather than at a release gate."_ This track is, by name, a release
gate. That is a real contradiction and candidates were generated against it
rather than around it. Two honest resolutions exist, and every candidate below
takes one of them:

1. **Accrual, not inspection.** The pre-release artifact is a _read_ of evidence
   the engineer already produced mid-development — nothing new is computed at
   the gate, so the gate costs the primary persona nothing. Candidates 1, 5, 6
   and 7 take this horn.
2. **A different persona.** STRATEGY.md's _secondary_ persona — client-success
   and delivery staff answering "is this client's platform healthy?" — has no
   mid-development moment at all. For them the launch or onboarding _is_ the
   working moment, and bet 3 does not bind. Candidates 2, 7 and 9 take this
   horn.

Candidates 3, 4 and 8 are the ones that genuinely strain the bet: they compute
new work at the gate for the primary persona. That strain is recorded in their
objections rather than argued away.

## Ranked candidates

### 1. A pre-release abstention census: aggregate every zero-denominator and skip across a full canary run into one ranked "what was never checked" report — score: 9.00

- Persona: the engineer mid-development, and the delivery staff signing off —
  the two readers who currently see abstentions only one command at a time.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Our approach
  (degrade loudly, never silently guess) — recorded; |Δ| vs candidate 2 is 3.00,
  outside the tie window, so the bonus does **not** apply — final score 9.00
- Premise: canary already institutionalizes abstention per gate —
  `ts/src/core/gate-result.ts` defines `GateResult<F>` with a mandatory
  `checked` denominator, a `SkipEntry { name, reason }` list that D7 forces into
  _every_ summary line, and `EXIT_ABSTAINED = 3` reserved CLI-wide — but nothing
  aggregates them, so a release ships without anyone able to state what the
  toolchain declined to inspect; this candidate collects every skip and every
  zero denominator emitted across a full run and ranks the resulting dark
  surface by blast radius.
- Strongest objection: the value depends entirely on `SkipEntry.reason` being
  comparable across producers, and it demonstrably is not — the reasons are
  written at different grains by different surfaces (guardian emits short
  tokens, doctor emits sentences), so the census risks becoming a long
  undifferentiated list of strings that reads as noise and gets muted, which is
  the fate of every report that ranks nothing. Most likely failure mode: a
  release-day page of 200 skips, 190 of them structurally uninteresting ("no
  coverage file for vendor/"), burying the three that mattered. For the
  objection not to hold, the ranking must be driven by something other than the
  reason text — the impact mapper in `ts/src/guardian/impact-mapper.ts` or
  reachability in `ts/src/analysis/reachability.ts` would have to supply blast
  radius per dark unit, which makes this materially more than a `grep` over
  output.
- Objection answered: no — accepted downside.

### 2. Fixture-monoculture detection: measure whether the existing fixture corpus is diverse enough to have a chance of surviving a real client tenant — score: 6.75

- Persona: the engineer mid-development, immediately before a client onboarding
  hands their suite data it has never seen.
- Complexity: medium
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Target problem (a
  suite that passes without proving anything) — applied, |Δ| vs candidate 3 is
  0.00 — final score 6.75
- Premise: `ts/src/core/fixture-scanner.ts` already extracts `FixtureSymbols`
  from a suite and `ts/src/core/domain-scanner.ts` already builds a
  `DomainContext`, so the corpus is readable today; this candidate scores its
  _variety_ — every test user holding one role, every record small, every string
  ASCII, every collection non-empty — and reports the dimensions along which the
  suite has only ever seen one kind of world.
- Strongest objection: fixture monoculture is not obviously a defect — a
  well-designed unit suite is _supposed_ to use minimal, uniform fixtures, and
  the diversity this would demand belongs in integration and contract tests, so
  the finding may be correct and still be bad advice at the level it fires. Most
  likely failure mode: it nags a clean unit suite into carrying baroque fixtures
  that slow it down and prove nothing, degrading the thing it audits. It holds
  only if the scoring is scoped by test layer — which requires knowing the
  layer, and `ts/src/core/classifier.ts` classifies by `test_type` rather than
  by proximity to real data.
- Objection answered: no — accepted downside.

### 3. Target-environment tier pre-flight: report the evidence ceiling of the environment the gate will actually run in, before the release, not during it — score: 6.75

- Persona: the engineer mid-development preparing a demo or a client's CI, where
  the machine that runs the gate is not the machine they are sitting at.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Our approach (the
  Tier-0 engine with the agent tier strictly optional on top) — applied, |Δ| vs
  candidates 2 and 4 is 0.00 — final score 6.75
- Premise: `ts/src/guardian/tier.ts` resolves a requested tier against an
  `AgentCapabilityProbe` and emits its loud degradation notice _at run time_,
  which is the worst possible moment to learn that the client's air-gapped
  runner serves tier 0; this candidate probes a named target environment ahead
  of time and states the ceiling — agent runtime, coverage producer, framework
  binaries — so the expected evidence tier is known before anyone has promised
  an outcome.
- Strongest objection: a pre-flight probe of an environment you are not in is a
  prediction, and a confident wrong prediction here is worse than the loud
  run-time degradation it is trying to pre-empt — it would tell someone their
  client's CI serves tier 2 on the strength of a config file, and the real
  answer arrives only when the job runs. Most likely failure mode: the probe
  reads declared capability (a workflow file, a lockfile) and misses the actual
  one (a missing secret, an unavailable binary). For the objection not to hold,
  the output would have to be labeled as a _prediction_ at a lower fidelity tier
  than anything canary currently emits, which means inventing a tier below
  heuristic.
- Objection answered: no — accepted downside.

### 4. Tenant-coupling linter: statically flag the environment assumptions a suite hardcodes — identity, locale, currency, region, seeded IDs, base URLs — score: 6.75

- Persona: the delivery engineer standing up a client onboarding against a
  tenant whose data, locale and auth are nothing like the development one.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Who it's for
  (secondary: client-success and delivery) — applied, |Δ| vs candidate 3 is 0.00
  — final score 6.75
- Premise: `canary-blackhawk` already ships the temporal half of this idea —
  tests that pass all day and fail at midnight — and this is its non-temporal
  sibling: tests that pass in your tenant and fail in the client's, detected
  statically against signals canary already resolves in
  `ts/src/core/environment-detect.ts` (`detectBaseUrl` at line 274) and
  `ts/src/core/domain-scanner.ts`.
- Strongest objection: unlike a wall-clock dependency, a hardcoded tenant value
  is frequently correct — a fixture is _meant_ to pin a seeded user id, and a
  base URL in a config is the intended design — so the rule has no clean
  signature to key on and degenerates into flagging string literals, which is
  the highest-false-positive shape a linter can take. Most likely failure mode:
  it fires on `ts/src/core/string-literals.ts`-grade noise and is disabled in
  week one. Blackhawk escaped this only because frozen-clock idioms are a small,
  enumerable set that proves the author already handled it; no equivalent "I
  handled tenancy" idiom exists to suppress against.
- Objection answered: no — accepted downside.

### 5. An evidence staleness clock: age every coverage-verified claim against the last change to the unit it covers, and downgrade the tier when the evidence is older than the code — score: 4.50

- Persona: the engineer mid-development and the delivery signer, both of whom
  read "coverage-verified" today with no idea when it was last true.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Our approach
  (fidelity-labeled evidence, degrade loudly) — recorded; |Δ| vs candidate 4 is
  1.50, outside the tie window, so the bonus does **not** apply — final score
  4.50
- Premise: canary's fidelity ladder (coverage-verified › graph-verified ›
  heuristic) has no time dimension — a claim backed by a coverage run from six
  weeks and forty commits ago is labeled identically to one backed by this
  morning's run; this candidate gives every claim an age relative to the unit's
  last modification and makes staleness a _tier demotion_ rather than a
  footnote, so a release reads its evidence at the fidelity the evidence
  actually still has.
- Strongest objection: this changes the meaning of the project's central label,
  which means it can turn a green gate red on a repository where nothing is
  wrong — a stable, untouched module with a slightly old coverage run is exactly
  the case that should pass, and a naive age rule fails it. Most likely failure
  mode: a demotion cascade on a quiet release branch, teaching people that the
  demotion is noise, which devalues the fidelity ladder itself — the one asset
  the strategy says everything else rests on. It survives only if age is
  measured against the _unit's_ change history rather than the calendar, which
  is `ts/src/analysis/reachability.ts`-plus-git work, not a timestamp
  comparison.
- Objection answered: no — accepted downside.

### 6. Demo-window red probability: forecast, from run history, the chance that at least one test on a named path fails during a fixed-length demo or onboarding session — score: 4.00

- Persona: client-success and delivery staff deciding whether to run the suite
  live in front of a client, or show a recording.
- Complexity: medium
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Who it's for
  (secondary persona) — recorded; |Δ| vs candidate 5 is 0.50, outside the tie
  window, so the bonus does **not** apply — final score 4.00
- Premise: `ts/src/history/detector.ts` already computes per-test flake rates
  and `classifyFlakeTrend`, and the NDJSON store in `ts/src/history/` already
  persists the runs, so the arithmetic to turn N tests with known flake rates
  into a single "probability this goes red in front of the client" number is a
  composition of things that exist rather than new detection.
- Strongest objection: a probability is precisely the output shape this
  project's strategy distrusts — it is a verdict wearing a decimal point, and
  the flake rates feeding it come from a history store whose coverage of any
  particular repo is thin and non-stationary (a rate computed over eleven runs
  is not a rate). Most likely failure mode: a confident "3% chance of red" that
  is really an artifact of a small sample, quoted in a client meeting. For it
  not to hold, the output would have to carry its own denominator as loudly as
  the number — and at that point the honest version reads "we have 11 runs, we
  can't tell you", which is correct and also not a feature anyone asks for
  twice.
- Objection answered: no — accepted downside.

### 7. Cross-environment parity: run the same suite against two environments and diff the failure _signature_, to prove staging and the client tenant agree before onboarding day — score: 2.75

- Persona: client-success and delivery staff, whose onboardings fail on
  environment divergence (flags, seed data, auth config) far more often than on
  code defects.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Who it's for
  (secondary persona) — applied, |Δ| vs candidate 8 is 0.00 — final score 2.75
- Premise: `canary-shadow` proves two _versions_ of a thing agree by normalizing
  noise and diffing, and nothing in canary proves two _environments_ agree; this
  candidate reuses that normalization shape but varies the environment rather
  than the binary, using `detectBaseUrl` and `parsePlaywrightSuiteHints`
  (`ts/src/core/environment-detect.ts:274` and `:302`) to bind each run to a
  target, and reports divergence in what fails rather than in what is printed.
- Strongest objection: the two environments are _supposed_ to differ — different
  data, different scale, different flags — so a signature diff will be non-empty
  on every honest pair, and separating meaningful divergence from intended
  divergence requires a model of "what should differ" that nobody will write.
  Most likely failure mode: a wall of expected differences on the first run, an
  allowlist bolted on to quiet it, and the allowlist silently growing until the
  check passes vacuously — canary's own target problem, reproduced in a new
  place. It also requires live credentials for a client environment, which
  collides directly with STRATEGY.md's "Not working on" boundary.
- Objection answered: no — accepted downside.

### 8. Diff-scoped mutation testing: perturb the changed code and report which mutations the suite fails to catch, as the pre-release proof that the tests would actually detect a regression — score: 2.75

- Persona: the engineer mid-development whose diff is about to ship in a
  release.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Pre-release confidence, +0.25 Target problem
  (suites that pass without proving anything) — applied, |Δ| vs candidate 7 is
  0.00 — final score 2.75
- Premise: every existing canary answer to "does this test prove anything" is
  static — `ts/src/core/vacuity-scanner.ts` (1074 lines) and `canary-cassandra`
  read the test, they do not challenge it — and mutation testing is the only
  technique that answers the question by experiment: break the SUT, and a suite
  that stays green has just proved it proves nothing.
- Strongest objection: mutation testing's cost is multiplicative in suite
  runtime and its output is famously dominated by equivalent mutants —
  perturbations that are semantically identical and therefore _correctly_
  uncaught — so the report is expensive to produce and then requires expert
  triage to read, which is exactly the cost profile STRATEGY.md says lands on
  whoever has the least time. Most likely failure mode: it is run once,
  impresses everyone, and is never scheduled again because it takes forty
  minutes. Diff-scoping is the standard mitigation and genuinely helps, but it
  does not touch the equivalent-mutant problem, which is the half that makes the
  output hard rather than slow.
- Objection answered: no — accepted downside.

### 9. Freeze-window blast-radius advisor: during a launch freeze, rank incoming PRs by whether they touch the paths the launch depends on — score: 2.50

- Persona: the engineer mid-development who has a merge ready and needs to know
  whether it is safe to land during someone else's freeze.
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Pre-release confidence — applied, |Δ| vs
  candidate 8 is 0.00, and the bonus does not change its position — final score
  2.50
- Premise: `ts/src/guardian/impact-mapper.ts` and
  `ts/src/analysis/reachability.ts` already compute what a diff reaches, so a
  freeze can be expressed as a set of protected entry points and each open PR
  scored against it, replacing the blanket "nothing merges this week" with a
  ranked "these three are the ones that touch the launch".
- Strongest objection: freezes are a social instrument more than a technical one
  — their value is partly that they are blunt and require no one to adjudicate —
  so a tool that makes them negotiable mostly produces a new argument to have
  under time pressure, and the one PR that slips through on a low score is the
  one everyone remembers. Most likely failure mode: reachability says a change
  is unrelated, a runtime coupling the graph cannot see says otherwise, and the
  advisor is blamed for a launch incident it was never epistemically able to
  prevent. It holds only where the launch path is explicitly declared rather
  than inferred, and nobody declares it.
- Objection answered: no — accepted downside.

## Observations

- **The top candidate is the only one that computes nothing new.** Candidate 1
  aggregates a signal canary already emits from 24 registered surfaces, which is
  why it scores H/H/L and why it does not strain approach bet 3: it is a read of
  development-time evidence, presented at a release moment.
- **The tiebreaker was partly inert again.** Candidates 2, 3 and 4 all sit at
  base 6.00 and all earn the full +0.75, so no order changed; the same is true
  of 7 and 8 at 2.00. The one place the bonus did work was candidate 9, which
  earns only +0.5 (no target-problem or persona hook) and therefore stays last
  within its tie window rather than floating on generation order.
- **The three highest-effort candidates (7, 8, 2 by complexity) are the three
  that most strain the strategy.** Two require live client environments, which
  brushes the "Not working on" boundary; one requires runtime the primary
  persona does not have. That correlation is worth noticing before any of them
  is specced.
- **Shortfall is real, not a formatting artifact.** Nine of ten. This track is
  moderately saturated — `canary-cry` (#608), `canary-manhunter` (#611),
  `canary-huntress` (#617), `canary-misfit` (#592), `canary-harley` (#616) and
  `canary-mission-briefing` (#593) already occupy most of the obvious surface —
  and the tenth idea generated was a near-duplicate of #611 rather than a new
  one.
