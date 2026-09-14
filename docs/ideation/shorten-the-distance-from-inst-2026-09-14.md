---
topic: Shorten the distance from install to a first trustworthy gate
generated_at: 2026-09-14T02:03:36Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 10
ranking_formula:
  '(impact × confidence) ÷ effort; strategy-alignment tiebreaker (max +0.75)
  applied only when |Δbase_score| ≤ 0.05'
---

<!-- markdownlint-disable-file MD013 -->

# Ideation: Shorten the distance from install to a first trustworthy gate

## Inputs

- Topic: Shorten the distance from install to a first trustworthy gate
- Generated: 2026-09-14T02:03:36Z
- Strategy grounding: enabled — `read_strategy` returned
  `{ present: true, valid: true }`; tracks, target problem, approach, and
  who-it's-for all captured

## Method

Candidates were generated from a live read of the shipped surface, not from the
track blurb. Surfaces surveyed: the commander wiring in `ts/src/cli.ts` (`init`
:130, `setup` :143, `migrate` :153, `doctor` :308, `uninstall` :320), the
guardian sub-app in `ts/src/guardian/cli.ts` (`pr-check` :2004, `harden-gate`
:1928, `collect-adjudications` :1962, `precision` :1987), the adoption report in
`ts/src/core/adoption.ts`, the overlay workflow installer in
`ts/src/core/migrator.ts` (:1785-1980), the doctor shim in `npm/src/doctor.ts` +
`npm/src/doctor-manifest.ts`, and the `canary-ci-ready` agent skill. The earlier
run on this same track
(`docs/ideation/ease-canary-adoption-and-harde-2026-07-18.md`) was read in full
and its 16 candidates are deliberately not re-surfaced.

Two findings from that read shaped the slate. First, the track's own key metric
— "Time to first trustworthy gate ... derived from canary-ci-ready scoring"
(`STRATEGY.md` :58) — has no deterministic producer: `canary-ci-ready` exists
only as an LLM agent skill under `agents/skills/claude-code/canary-ci-ready/`,
and a grep of `ts/src/` finds no `ci-ready` scorer and no install-to-gate clock.
The metric is currently unmeasurable. Second, the word doing the work in this
track is **trustworthy**, not **fast**; several candidates below attack the
trust half, which the prior run did not touch at all.

## Ranked candidates

### 1. Refuse to promote the guardian gate to hard when the run backing the promotion evaluated zero units — score: 9.00

- Persona: the engineer who has just wired canary into a repo and is about to
  run `canary guardian harden-gate --apply` to make the gate real.
- Complexity: low
- Impact / Confidence / Effort: H/H/L — base score 9.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach
  ("degrades loudly when the evidence tier drops rather than silently guessing")
  = +0.75 recorded, NOT applied (|Δ| vs next candidate = 3.00 > 0.05) — final
  score 9.00
- Key risk: the zero-evaluation condition may be common enough in legitimate
  first runs that the refusal reads as canary blocking its own adoption.
- Strongest objection: `harden-gate` today verifies only that the status-check
  _context_ exists (`--force` is documented as skipping "the
  check-context-exists verification"), and adding a second precondition makes
  the single command that completes onboarding more likely to fail. The most
  likely failure mode is that a consumer's genuinely-empty first PR — a docs
  change, a config tweak, a branch with no touched units — trips the refusal,
  the engineer reads it as a canary defect rather than a true abstention, and
  reaches for `--force`, which trains the exact bypass reflex the check exists
  to prevent. For this objection not to hold, the refusal would need to
  distinguish "this run abstained because nothing was in scope" from "this gate
  cannot evaluate anything" and say so in different words with different
  remedies, which is more design than the low effort estimate assumes.
- Objection answered: no — stands as an accepted downside.

### 2. Stamp an adoption clock so time-to-first-trustworthy-gate is a measured number rather than an aspiration — score: 6.50

- Persona: the maintainer of canary itself, who publishes "Time to first
  trustworthy gate" as a key metric and today has no instrument that emits it.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Adoption and onboarding — final score 6.50
- Key risk: a clock measures elapsed wall time, which for a real adoption is
  dominated by the human's calendar rather than by any friction canary controls.
- Strongest objection: the metric's denominator is the problem, not its
  arithmetic. Wall-clock elapsed time between an install record and a first
  green guardian run conflates the minutes canary is responsible for with the
  days a consumer spent waiting on a code review, a CI credential, or a sprint
  boundary — so the number will move for reasons no canary change caused, and
  will not move when a real friction is fixed. The most likely failure mode is a
  metric that gets published, read as flat, and quietly retired. For the
  objection not to hold, the clock would have to record the sequence of adoption
  _steps_ and their individual gaps rather than one elapsed total, so the
  maintainer can see which step actually holds people up — which is a different
  and larger instrument than a start and end timestamp.
- Objection answered: no — stands as an accepted downside.

### 3. Make the adoption report emit the single next action instead of a list of independent gaps — score: 6.50

- Persona: the first-time adopter who ran `canary migrate --adoption-report`,
  got six missing pieces with six remedies, and does not know which one unblocks
  the others.
- Complexity: low
- Impact / Confidence / Effort: M/H/L — base score 6.00
- Strategy alignment: +0.5 track:Adoption and onboarding — final score 6.50
- Key risk: the pieces may not have a stable dependency order, in which case any
  "next action" canary names is a guess dressed as guidance.
- Strongest objection: `ts/src/core/adoption.ts` deliberately reports per-piece
  present/missing with a remedy under each gap, and it is honest precisely
  because it makes no claim about ordering. Collapsing six true observations
  into one recommended action asserts a dependency graph between company.json,
  shape resolution, overlay, skills, manifest, and workflows that the code does
  not actually model — and a wrong ordering is worse than no ordering, because a
  newcomer who follows it and lands nowhere loses trust in the report that was
  the trustworthy part. The most likely failure mode is a hardcoded sequence
  that drifts out of step with the migrator. For this not to hold, the ordering
  would have to be derived from the same resolution machinery `checkFreshness`
  already runs, not written down beside it.
- Objection answered: no — stands as an accepted downside.

### 4. Ship `canary ci-ready` as a deterministic Tier-0 command so the track's key metric has a producer that imports no LLM — score: 3.75

- Persona: the engineer mid-development, downstream of harness-engineering, who
  wants to know whether the suite is ready to gate without spending an LLM turn
  to find out.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach ("a
  deterministic Tier-0 engine that imports no LLM, with the agent tier strictly
  optional on top") — final score 3.75
- Key risk: three of the skill's five checks (assertion quality, critical-path
  coverage, documented-failure acceptance) may be irreducibly judgment-shaped,
  so a deterministic port would score a narrower thing under the same name.
- Strongest objection: the five checks in
  `agents/skills/claude-code/canary-ci-ready/SKILL.md` are not uniformly
  mechanizable. Coverage depth and suite runtime are; "assertion quality" and
  "accepts documented failures — quarantined tests with linked open issues count
  as verified" involve reading intent out of prose and out of an issue tracker.
  A Tier-0 port that keeps the name while dropping or approximating those checks
  produces a readiness score that is reproducible and cheap but measures less
  than the skill it replaces, and — worse — one that the strategy's own metric
  then treats as authoritative. The most likely failure mode is a confidently
  wrong readiness number. For this objection not to hold, the deterministic
  command would need to report which of the five dimensions it actually
  evaluated and abstain loudly on the rest, rather than emitting a single
  blended score.
- Objection answered: no — stands as an accepted downside.

### 5. Unify the abstention vocabulary across the three onboarding surfaces so a newcomer reads one grammar, not three — score: 3.75

- Persona: the first-time adopter who meets `canary doctor`,
  `canary migrate --adoption-report`, and `canary guardian pr-check` on day one
  and has to learn each one's idea of "couldn't tell" separately.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach
  ("degrades loudly when the evidence tier drops rather than silently guessing")
  — final score 3.75
- Key risk: the three surfaces abstain for genuinely different reasons, so one
  vocabulary may flatten distinctions that matter.
- Strongest objection: the divergence is structural, not cosmetic.
  `npm/src/doctor.ts` carries `EXIT_ABSTAINED`, a `skip` status, and
  `abstentionRemedy`; `ts/src/core/adoption.ts` models its own `unknown` verdict
  that is explicitly "not a soft pass and not a soft fail"; and the shared
  `gate-result.ts` `SkipEntry.reason` already carries different grain per
  producer (guardian tokens versus doctor sentences). Unifying them means either
  widening the shared type until it means nothing or forcing one producer to lie
  about why it abstained. The most likely failure mode is a refactor that makes
  the three surfaces _look_ consistent while each one's reason field silently
  loses fidelity — a cosmetic win paid for in exactly the evidence quality the
  project sells. For this not to hold, the unification would have to be a shared
  presentation layer over preserved per-producer reasons, not a shared reason
  type.
- Objection answered: no — stands as an accepted downside.

### 6. Graduate the gate automatically: propose hardening only after adjudicated precision clears a threshold — score: 3.75

- Persona: the adopter whose gate is stuck soft forever, because nothing tells
  them when it has earned the right to block.
- Complexity: medium
- Impact / Confidence / Effort: H/M/M — base score 3.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach
  ("auditable provenance is the precondition for letting an agent near a merge
  gate") — final score 3.75
- Key risk: adjudication data depends on reviewers actually reacting to the
  sticky comment, so the graduation signal may never accumulate in a repo where
  nobody engages.
- Strongest objection: this composes three surfaces that already ship
  (`collect-adjudications`, `precision`, `harden-gate`) into a promotion rule,
  but every one of them reads a signal the consumer generates voluntarily. A
  team that ignores the sticky comment produces zero adjudications, and zero
  adjudications is an abstention — so the graduation rule either never fires
  (the gate stays soft indefinitely, which is the status quo it was built to
  fix) or fires on a sample so small the precision figure is noise. The most
  likely failure mode is a threshold cleared by four thumbs-up from one
  enthusiastic reviewer, promoting a gate on essentially no evidence. For this
  objection not to hold, the rule would need a minimum-sample floor and would
  have to state its own denominator when it declines to fire, and even then it
  only works for teams already engaging with the gate — which is not the adopter
  this track is worried about.
- Objection answered: no — stands as an accepted downside.

### 7. Give `canary migrate --apply` an inverse, so adopting is a reversible decision — score: 3.50

- Persona: the engineer evaluating canary on a repo they do not solely own, who
  will not run a command that writes skills, a manifest, and workflow files with
  no way back.
- Complexity: medium
- Impact / Confidence / Effort: M/H/M — base score 3.00
- Strategy alignment: +0.5 track:Adoption and onboarding — final score 3.50
- Key risk: `.github/workflows/` is explicitly the consumer's property under the
  #459 decision, so an undo that touches it violates the ownership line the
  migrator was careful to draw.
- Strongest objection: reversibility and the ownership boundary pull in opposite
  directions. The migrator's stated rule is that a workflow which differs from
  the template is _present_ — adopted, then edited — and never a finding,
  precisely because canary has no claim over a consumer's CI. An undo that
  removes a workflow canary installed but the consumer subsequently edited
  destroys their work; an undo that refuses to touch edited workflows leaves the
  adoption half-reverted, which is the same nameable-partial-adoption state
  `adoption.ts` exists to complain about. The most likely failure mode is an
  undo that is safe and therefore incomplete, giving the reassurance without the
  property. For this not to hold, the deploy manifest would have to record
  content hashes at install time so the undo can distinguish untouched from
  edited per file and report the remainder explicitly rather than silently
  leaving it.
- Objection answered: no — stands as an accepted downside.

### 8. Prove the newly-installed gate catches something, by running it against a planted regression in the consumer's own repo — score: 2.75

- Persona: the adopter whose first guardian run came back green and who has no
  way to distinguish "this code is well tested" from "this gate is not wired
  up".
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach
  ("Canary never asserts 'this is tested' — it states how it knows") — final
  score 2.75
- Key risk: planting a defect in someone else's repository, even transiently and
  even in a scratch copy, is an intrusive act that a security-conscious consumer
  may simply refuse.
- Strongest objection: a first green result is ambiguous exactly as described,
  but the proposed cure requires canary to mutate a consumer's working tree — or
  to build a faithful scratch copy of it, including their test runner, their
  dependencies, and their coverage producer — in order to observe a red. The
  most likely failure mode is that the rehearsal fails to reproduce the
  consumer's environment, produces a red for an environmental reason, and
  reports "your gate works" on the strength of a failure that had nothing to do
  with the planted defect: a false green wearing a red coat. For the objection
  not to hold, the rehearsal would need to assert not merely that the gate went
  red but that it went red _citing the planted unit_, which is a much stronger
  and more fragile claim than "a failure occurred". This is distinct from
  adopting harness-rehearse fixtures, which regression-tests canary's own gates
  in canary's own repo; this candidate is consumer-facing and carries the
  consumer-repo risk that one does not.
- Objection answered: no — stands as an accepted downside.

### 9. Discover the coverage producer automatically, so a newcomer's first gate is coverage-verified rather than heuristic by default — score: 2.75

- Persona: the adopter whose first `pr-check` degrades to heuristic tier purely
  because nobody told canary where lcov lands or how to reach the base ref's
  coverage.
- Complexity: high
- Impact / Confidence / Effort: H/M/H — base score 2.00
- Strategy alignment: +0.5 track:Adoption and onboarding, +0.25 Our approach
  (fidelity ranked coverage-verified › graph-verified › heuristic) — final score
  2.75
- Key risk: auto-discovery is the exact shape of silently-degraded tooling — a
  discoverer that finds the wrong artifact produces confident coverage-verified
  findings from stale or unrelated data.
- Strongest objection: `pr-check` takes `--coverage` and `--base-coverage` as
  explicit paths, and the head-only degradation is already documented as loud
  (#606). Replacing an explicit path with inference trades a loud, correct
  abstention for a quiet, possibly-wrong assertion — and the failure is
  invisible, because a stale lcov from a previous run parses perfectly and
  yields coverage-verified findings at the top evidence tier. The base-coverage
  half is worse still: obtaining the merge base's coverage means either
  re-running the consumer's suite at another ref (slow, and it may not build) or
  trusting a cached artifact whose provenance canary does not control. The most
  likely failure mode is the project's own headline anti-pattern, a gate that
  reports high-fidelity evidence it did not actually earn. For this not to hold,
  discovery would have to record and display the provenance and freshness of
  every artifact it selected, and refuse any artifact it cannot date.
- Objection answered: no — stands as an accepted downside.

### 10. Make each doctor check's remedy machine-applicable instead of prose for the human to retype — score: 2.50

- Persona: the newcomer reading a doctor report of failed checks, each with a
  remedy they must translate into a command themselves.
- Complexity: medium
- Impact / Confidence / Effort: M/M/M — base score 2.00
- Strategy alignment: +0.5 track:Adoption and onboarding — final score 2.50
- Key risk: remedies today are free-text strings written for humans, so the
  structured half has to be authored check by check before anything can be
  applied.
- Strongest objection: `npm/src/doctor-manifest.ts` carries `remedy: string` per
  check alongside an optional `command` array, which makes this look like wiring
  — but the remedies were written as explanations, not as executable steps, and
  the safe-to-automate subset is likely small. The most likely failure mode is a
  `--fix` flag that handles the three trivial checks, silently skips the rest,
  and leaves the user believing doctor fixed what it could when in fact it
  declined most of the work — a partial pass presented as a pass, which is the
  abstention-shaped failure the project treats as a headline. There is also a
  blast-radius concern: doctor runs in the CommonJS npm shim that structurally
  cannot import the ESM engine, so any remedy needing engine machinery cannot be
  applied from where the remedy is displayed. For this not to hold, `--fix`
  would have to enumerate what it did not attempt, by name, every run.
- Objection answered: no — stands as an accepted downside.

## Ranking table

| Rank | Final | Base | Alignment                   | Candidate                                                |
| ---- | ----- | ---- | --------------------------- | -------------------------------------------------------- |
| 1    | 9.00  | 9.00 | +0.75 recorded, not applied | Refuse hard-gate promotion on a zero-evaluation run      |
| 2    | 6.50  | 6.00 | +0.5 applied                | Adoption clock for time-to-first-trustworthy-gate        |
| 3    | 6.50  | 6.00 | +0.5 applied                | Adoption report emits the single next action             |
| 4    | 3.75  | 3.00 | +0.75 applied               | Deterministic Tier-0 `canary ci-ready`                   |
| 5    | 3.75  | 3.00 | +0.75 applied               | Unified abstention vocabulary across onboarding surfaces |
| 6    | 3.75  | 3.00 | +0.75 applied               | Automatic gate graduation on adjudicated precision       |
| 7    | 3.50  | 3.00 | +0.5 applied                | Reversible `canary migrate --apply`                      |
| 8    | 2.75  | 2.00 | +0.75 applied               | Planted-regression rehearsal in the consumer repo        |
| 9    | 2.75  | 2.00 | +0.75 applied               | Automatic coverage-producer discovery                    |
| 10   | 2.50  | 2.00 | +0.5 applied                | Machine-applicable doctor remedies                       |

Tie-window note: the bonus was applied within each equal-base cluster (|Δ| =
0.00 ≤ 0.05) and withheld from rank 1, whose nearest neighbour sits 3.00 below
it. No bonus crosses a cluster boundary — the largest bonus (+0.75) is smaller
than every inter-cluster gap (3.00, 3.00, 1.00), so no clear base-score winner
was reordered.

## Handoff

- Ideation artifact written:
  `docs/ideation/shorten-the-distance-from-inst-2026-09-14.md`
- Top pick: Refuse to promote the guardian gate to hard when the run backing the
  promotion evaluated zero units — score 9.00
- Next: invoke `/harness:brainstorming` to take a candidate into a spec, OR
  `/harness:roadmap` to enqueue picks for later.
