---
topic:
  Turn per-run, per-person evidence into durable signal that accrues over time
  and reads to people who do not open the code, including recognizing sound
  engineering
generated_at: 2026-09-14T02:07:39Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 5
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Quality made legible (STRATEGY.md track 5)

## Inputs

- Topic: Turn per-run, per-person evidence into durable signal that accrues over
  time and reads to people who do not open the code, including recognizing sound
  engineering.
- Generated: 2026-09-14T02:07:39Z
- Strategy grounding: enabled — STRATEGY.md v2, 5 tracks. This is track 5
  ("Quality made legible"). Audience is the **secondary** persona from
  `Who it's for`: client-success and delivery staff who need to answer "is this
  client's platform healthy and well-covered?" without reading code.
- Objections: policy `none` — every strongest objection stands as an accepted
  downside. No rebuttals were authored.

## Shortfall: 5 generated against 10 requested

**This track is the most saturated in the repo, and the short artifact is the
finding.** 10 were requested; 5 distinct candidates survived a live read of the
shipped surface. The remainder would have been near-duplicates of work that
already ships or is already proposed, and the skill's own gate prefers
fewer-but-distinct over more-but-redundant.

What the live read found already shipped against this track:

| Surface                                                     | Where                                            |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Run-history store (NDJSON + Supabase)                       | `ts/src/history/` — `store.ts`, `schema.ts`      |
| `canary history` push/record/flaky/timeline/summary/migrate | `ts/src/history/cli.ts:729`                      |
| `canary analyze` — 5 report types + `digest`                | `ts/src/analysis/cli.ts:636-754`                 |
| Markdown report builders (pure)                             | `ts/src/analysis/reports.ts`                     |
| Cross-run broken-main siren                                 | `agents/skills/claude-code/canary-screech/`      |
| Fleet-wide health summary skill                             | `agents/skills/claude-code/canary-fleet-health/` |
| Per-PR impact summary comment                               | `ts/src/guardian/summary-emitter.ts`             |
| Per-test quality score                                      | `ts/src/core/quality-scorer.ts`                  |
| Structured promotion verdict                                | `ts/src/core/promotion-verdict.ts`               |
| Zero-denominator abstention doctrine                        | `ts/src/core/gate-result.ts`                     |
| Persona registry + resolver                                 | `ts/src/core/persona.ts`                         |
| Adoption report                                             | `ts/src/core/adoption.ts`                        |
| Tracker run-comment posting                                 | `ts/src/core/ticket-updater.ts`                  |

Ideas rejected at generation time as re-proposals of existing or open work:
`canary-signal` (#609), `canary-manhunter` (#611), `canary-batgirl` (#619),
audit evidence export (#855), measure-abandonment (#491), `canary-clocktower`
(#610), `canary-rewind` (#461), `canary-shiva` (#460), voice pack (#340),
`canary history` store (shipped), `canary-batwoman` (shipped, #749), ci-ready
scoring (shipped). Two further shapes were generated and then discarded as thin
wrappers: a "what changed since you last looked" diff of two `analyze digest`
runs, and a trend line over `scaling-curve.ts` verdicts — the first is a
parameter on a shipped command, the second is a perf concern wearing a
legibility costume.

## Ranked candidates

### 1. Render `canary analyze digest` through the persona resolver so the fleet digest is emitted at an explanation depth the secondary persona can read — score: 6.00

- Persona: client-success and delivery staff who query canary for coverage,
  health, and fleet status without opening the code.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 `Who it's for`
  secondary persona — recorded, **not applied** (|Δ| to next candidate = 1.50 >
  0.05) — final score 6.00
- Premise: wire `ts/src/core/persona.ts`'s resolver into the `analyze digest`
  report builders so one command emits either the engineer-grain digest or a
  plain-language one, with the persona and the reason it was chosen stated in
  the output.
- Strongest objection: the persona machinery already ships and nothing consumes
  it on this surface, which is evidence that the wiring is not the hard part —
  the hard part is the prose, and a resolver cannot write it. The most likely
  failure mode is a "simple" rendering that is merely the same table with the
  column headers reworded, which does not answer "is this client healthy" any
  better than the engineer version and adds a maintenance fork to every report
  builder in `reports.ts`. For this objection not to hold, the non-engineer
  rendering would have to change what is _selected_ and _concluded_, not just
  how it is phrased — and that judgment is currently nowhere in the codebase.
- Objection answered: no — accepted downside.

### 2. Carry the evidence tier (coverage-verified / graph-verified / heuristic) into the run-history record and trend it — score: 4.50

- Persona: client-success and delivery staff asking whether a client's green is
  backed by real coverage evidence; secondarily the engineer whose gate the tier
  governs.
- Complexity: medium
- Impact / Confidence / Effort: H/H/M — base score 4.50
- Strategy alignment: +0.5 track:Coverage evidence fidelity, +0.25
  `Our approach` (fidelity-labeled evidence) — recorded, **not applied** (|Δ| to
  next candidate = 0.50 > 0.05) — final score 4.50
- Premise: add an evidence-tier field to `RunInput`/`TestResultInput` in
  `ts/src/history/schema.ts` and emit a tier-share trend report, so
  "coverage-verified finding share" — named as a key metric in STRATEGY.md — is
  a line that moves over time rather than a number recomputed per PR and
  discarded.
- Strongest objection: this makes the central bet auditable, but it puts a
  ratchet on a number that legitimately drops for reasons nobody did wrong — a
  new language in the repo with no Cobertura producer, a vendored directory, a
  CI runner that stopped uploading coverage. The likely failure mode is that the
  trend line falls, nobody can attribute the fall, and the metric is quietly
  stopped being read, which is worse than never having trended it because the
  chart stays on the wall. It also requires a schema migration on a store that
  already carries `schema_version` and a `migrate` command, so every historical
  record is tierless and the trend begins with a cliff that is an artifact, not
  a regression. For this not to hold, the tier would need to be recorded
  alongside _why_ it is what it is, at the same grain, from day one.
- Objection answered: no — accepted downside.

### 3. Emit a sound-engineering commendation on a PR from evidence already computed — score: 4.00

- Persona: the engineer mid-development whose careful work is currently
  invisible to every canary surface; read downstream by delivery staff.
- Complexity: low
- Impact / Confidence / Effort: M/M/L — base score 4.00
- Strategy alignment: +0.5 track:Quality made legible ("recognizing sound
  engineering, not only detecting unsound engineering") — recorded, **not
  applied** (|Δ| to next candidate = 1.00 > 0.05) — final score 4.00
- Premise: add a positive block to `ts/src/guardian/summary-emitter.ts` that
  names specific good work already detected by shipped machinery — a positive
  coverage delta on touched units (#606/#881), a new test that passes the
  vacuity scanner, a quarantined test re-enabled and green — as a per-change
  event, not a per-person aggregate.
- Strongest objection: every shipped surface in this family is a defect detector
  for a reason — a negative finding is falsifiable and a commendation is not.
  The likely failure mode is that praise emitted by a bot on a fixed rule is
  read as noise within two sprints, and worse, becomes a target: once engineers
  learn which three conditions trigger it, the conditions get satisfied
  deliberately and the signal inverts into exactly the assertion-free-test
  problem STRATEGY.md's target problem describes, now with a compliment
  attached. It is also one step from the per-developer scorecard that was ranked
  last of fourteen in the 2026-07-21 artifact precisely because it risks
  manufacturing the target problem. For this not to hold, the commendation would
  have to stay strictly per-change, never aggregate to a person or a
  leaderboard, and be cheap enough to delete when it stops being read.
- Objection answered: no — accepted downside.

### 4. Accrue gate abstentions into a dark-gate ledger so "how long has this client's gate been blind?" is answerable — score: 3.00

- Persona: client-success and delivery staff who must distinguish a client whose
  gate passed 40 times from one whose gate verified nothing 40 times.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 `Target problem`
  ("suites then decay silently") — recorded, **not applied** (|Δ| to next
  candidate = 2.00 > 0.05) — final score 3.00
- Premise: persist the `checked` denominator and `SkipEntry` list that
  `ts/src/core/gate-result.ts` already emits per run into the history store, and
  report consecutive-abstention streaks per suite — so a gate that has been dark
  for six weeks reads as dark rather than as green.
- Strongest objection: the per-run half of this is the one piece of the doctrine
  that already works loudly and structurally, so the accrual only pays off in
  repos where somebody was already ignoring a visible warning on every single
  run — a population that is, by construction, not reading reports. The concrete
  blocker is that `SkipEntry.reason` is not written at a consistent grain across
  producers (guardian emits short tokens, doctor emits sentences), so a streak
  rolled up across producers either groups on a field that does not group or
  needs a producer-contract change first, which is a larger and duller piece of
  work than the ledger itself. For this not to hold, the reason field would have
  to be normalized before any accrual is built, which reorders this behind work
  nobody has scoped.
- Objection answered: no — accepted downside.

### 5. Join incident/tracker data against gate findings to compute the escaped-defect ratio — score: 1.00

- Persona: client-success and delivery staff, and anyone who has to justify the
  gate's existence with a number rather than an anecdote.
- Complexity: high
- Impact / Confidence / Effort: H/L/H — base score 1.00
- Strategy alignment: +0.5 track:Quality made legible, +0.25 `Key metrics`
  (escaped-defect ratio) — recorded, **not applied** (no adjacent candidate
  within 0.05) — final score 1.00
- Premise: reconcile issue-tracker labels against guardian findings and
  test-reporter run artifacts — using the tracker connection and semantic-role
  mapping `ts/src/core/ticket-updater.ts` and `WorkflowDiscovery` already hold —
  to compute defects caught pre-release versus found post-release.
- Strongest objection: STRATEGY.md names this as key metric #1 and in the same
  breath states that it "requires an incident-data join canary does not hold
  today — tracked manually at first", which is an accurate assessment rather
  than a gap waiting to be closed. The number depends entirely on tracker
  hygiene that lives outside canary and varies per client: if defects are not
  labelled consistently at the moment they are filed, the ratio is not
  approximately right, it is arbitrary, and a confidently-printed arbitrary
  ratio about whether the product works is the most damaging false-green this
  repo could ship. It also brushes directly against `Not working on` — the join
  is most valuable per-client, and per-client content is exactly what the
  open-core engine excludes. For this not to hold, the join would have to
  abstain loudly and by default on any tracker whose label coverage it cannot
  verify, which is most of them.
- Objection answered: no — accepted downside.

## Observations

- **The shortfall is the result.** Five of ten is not a failed run; a live read
  of `ts/src/` and `agents/skills/` against twelve known existing or proposed
  items left five genuinely distinct shapes. Track 5 is close to saturated at
  the idea level, and the remaining value is in wiring and in one metric the
  strategy already admits it cannot hold.
- **The alignment tiebreaker was recorded but never applied.** No two adjacent
  base scores fall within the 0.05 window, so every bonus is transparency only
  and the base score determines every position. This differs from the 2026-07-21
  run, where the bonus was inert because it was uniform inside the tie windows.
- **Effort inverts against impact across the list.** The top candidate is the
  cheapest and consumes machinery already paid for; the highest-impact candidate
  (5) is the least confident. Nothing here is both cheap and transformative,
  which is itself a saturation signal.
- **Candidate 3 is the only one addressing the second half of the track.**
  "Recognizing sound engineering" remains unbuilt across the entire surface —
  every shipped legibility output is a defect detector. That it ranks third
  rather than first reflects the strength of its objection, not its novelty.
