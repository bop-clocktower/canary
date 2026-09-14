<!-- markdownlint-disable-file MD013 -->

# Ideation shortlist — 5-theme strategy sweep

**Batch date (pinned, UTC):** 2026-09-13 **Base:** `origin/main` @ `9951c023`
**Themes:** 5, derived from `STRATEGY.md` tracks only (no opportunity areas
supplied) **Bounds:** count 10/theme · cut 3/theme · cap 10 · lookback 90d ·
concurrency 2 · objection policy `none`

Nothing here is filed. Nothing is committed, staged, or pushed. This shortlist
and the five collected per-theme artifacts are working-tree changes you keep or
discard. A pick becomes work only when you route it yourself.

Every score below was **independently re-derived** by the orchestrator from each
candidate's own recorded impact/confidence/effort, not taken from a worker's
report.

## Shortlist (10 of 44 candidates)

| #   | Premise                                                                                                                                                         | Theme                      | Re-derived score                                              | Standing objection                                                                                                                                                                                                                                                                              | Novelty                                                                                                                                                                                   | Artifact                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Pre-release abstention census — aggregate every zero-denominator and skip across a full canary run into one blast-radius-ranked "what was never checked" report | pre-release-confidence     | **9.00** (H/H/L, base 9.00, bonus +0.75 recorded not applied) | `SkipEntry.reason` grain differs across producers, so the census risks being an unranked wall of strings that gets muted; it only works if blast radius comes from impact-mapper reachability rather than the reason text                                                                       | novel                                                                                                                                                                                     | [adversarial-exploration-ahead-2026-09-14.md](../adversarial-exploration-ahead-2026-09-14.md)   |
| 2   | Refuse `canary guardian harden-gate --apply` when the backing run evaluated zero units                                                                          | adoption-and-onboarding    | **9.00** (H/H/L, base 9.00, bonus +0.75 recorded not applied) | `harden-gate` today only verifies the check _context_ exists; a second precondition makes the onboarding-completing command likelier to fail, and a legitimately empty first PR tripping it trains the `--force` bypass reflex                                                                  | novel — adjacent to shipped #526/#508 (harden-gate exits 3 on abstention), which does **not** check the run's denominator                                                                 | [shorten-the-distance-from-inst-2026-09-14.md](../shorten-the-distance-from-inst-2026-09-14.md) |
| 3   | Dispatch coverage-report format by sniffing content instead of by filename                                                                                      | coverage-evidence-fidelity | **6.75** (M/H/L, base 6.00, bonus +0.75 applied on exact tie) | Trades a loud predictable rejection for a quiet probabilistic one; a mis-sniffed dialect yields a `COVERAGE_VERIFIED` verdict out of a mis-parse, strictly worse than the heuristic tier it replaced                                                                                            | novel                                                                                                                                                                                     | [widen-what-qualifies-as-covera-2026-09-14.md](../widen-what-qualifies-as-covera-2026-09-14.md) |
| 4   | A signal-consumption ledger test — mechanically enumerate every computed scorer/linter/detector signal and fail on one that reaches no reader                   | test-intelligence-depth    | **6.75** (M/H/L, base 6.00, bonus +0.75 applied on exact tie) | A ledger is bookkeeping, not capability; most likely failure is that every current gap is annotated `unconsumed: intentional` to make it green on day one, and it rots into a second source of truth that disagrees with the code — the drift class canary exists to catch, committed by canary | novel                                                                                                                                                                                     | [turn-signals-canary-already-co-2026-09-14.md](../turn-signals-canary-already-co-2026-09-14.md) |
| 5   | Gate-input availability preflight — render which gate inputs were degraded or unavailable, so a green comment cannot be read as a clean bill of health          | test-intelligence-depth    | **6.75** (M/H/L, base 6.00, bonus +0.75 applied on exact tie) | `pr-check.ts` already encodes this for coverage (#554), so a generalized second preflight risks being a refactor wearing a feature's clothes; the failure mode is a permanent wall of "history store: empty" that readers learn to skip, costing the coverage warning its existing weight       | novel — adjacent to shipped #508 no-silent-abstention, which covers _checks_, not gate _inputs_                                                                                           | [turn-signals-canary-already-co-2026-09-14.md](../turn-signals-canary-already-co-2026-09-14.md) |
| 6   | Fixture-monoculture detection — score the existing fixture corpus's variety rather than its size                                                                | pre-release-confidence     | **6.75** (M/H/L, base 6.00, bonus +0.75 applied on exact tie) | Uniform fixtures are correct in a unit suite, so the finding can be true and still be bad advice; it would need layer scoping, and the classifier keys on `test_type`, not proximity to real data                                                                                               | novel — adjacent to the `canary-ivy` suite-overgrowth row (#615), which targets duplication/pruning, not variety                                                                          | [adversarial-exploration-ahead-2026-09-14.md](../adversarial-exploration-ahead-2026-09-14.md)   |
| 7   | Target-environment tier pre-flight — report ahead of time the evidence ceiling of the environment the gate will actually run in                                 | pre-release-confidence     | **6.75** (M/H/L, base 6.00, bonus +0.75 applied on exact tie) | A pre-flight probe of an environment you are not in is a prediction, and a confident wrong one is worse than `tier.ts`'s loud run-time degradation; honest labeling would need a tier below heuristic                                                                                           | novel                                                                                                                                                                                     | [adversarial-exploration-ahead-2026-09-14.md](../adversarial-exploration-ahead-2026-09-14.md)   |
| 8   | Go `coverprofile` reader (`mode: set\|count\|atomic` blocks) as a first-class report format                                                                     | coverage-evidence-fidelity | **6.50** (M/H/L, base 6.00, bonus +0.50 applied on exact tie) | Block-based records expand across line spans, crediting non-statement lines as measured and inflating the coverable denominator that #508/#554 built                                                                                                                                            | novel                                                                                                                                                                                     | [widen-what-qualifies-as-covera-2026-09-14.md](../widen-what-qualifies-as-covera-2026-09-14.md) |
| 9   | One rule-ID registry across quality-scorer, static-linter, blackhawk and savant                                                                                 | test-intelligence-depth    | **6.50** (M/H/L, base 6.00, bonus +0.50 applied on exact tie) | A registry that unifies IDs without unifying the detectors leaves the duplicate regexes in place — the same string is still matched twice and only the label agrees; the genuine consolidation then never happens because the symptom stopped showing                                           | novel — adjacent to #789 (mints canary-\* _names_ in one registry, not rule IDs) and to the "third overlapping half-enforcer" caveat already recorded on the soundness-linter roadmap row | [turn-signals-canary-already-co-2026-09-14.md](../turn-signals-canary-already-co-2026-09-14.md) |
| 10  | Adoption clock — stamp install → first green guardian, so "time to first trustworthy gate" has a producer                                                       | adoption-and-onboarding    | **6.50** (M/H/L, base 6.00, bonus +0.50 applied on exact tie) | Wall-clock elapsed time conflates canary-controlled minutes with the consumer's calendar — it moves for reasons no canary change caused, and stays flat when real friction is fixed                                                                                                             | novel                                                                                                                                                                                     | [shorten-the-distance-from-inst-2026-09-14.md](../shorten-the-distance-from-inst-2026-09-14.md) |

Reserved slots (one per non-thin theme, so no non-thin theme is erased): rows 2,
3, 4. Remaining seven filled by re-derived final score descending; ties broken
by SELECT order then artifact order. The cap was **not** raised — 3 reserved
≤ 10.

## Per-theme verdicts

| Theme                      | SELECT order | Verdict  | count | All-OS CI      |
| -------------------------- | ------------ | -------- | ----- | -------------- |
| coverage-evidence-fidelity | 1            | verified | 10/10 | not applicable |
| test-intelligence-depth    | 2            | verified | 10/10 | not applicable |
| pre-release-confidence     | 3            | **thin** | 9/10  | not applicable |
| adoption-and-onboarding    | 4            | verified | 10/10 | not applicable |
| quality-made-legible       | 5            | **thin** | 5/10  | not applicable |

All-OS CI is recorded **not applicable** rather than skipped: this member
produces no code and no PR, so that check has no subject. Base freshness is
not-applicable for the same reason — no verdict here derives from a CI
conclusion.

## Non-shortlisted outcomes

- **Already-known drops (1).** `canary coverage doctor <report>`
  (coverage-evidence-fidelity, score 9.00 — the batch's joint-highest) is
  covered by **open issue #883**, whose proposal items 1 and 2 are the same
  premise: distinguish "changed files lie outside every instrumented tree" from
  "the report is missing or stale", and report the eligible denominator. Dropped
  citing #883.
- **Backfills (1).** That drop backfilled coverage-evidence-fidelity's next
  below-cut candidate — "accept `--coverage` repeatedly and merge the report
  indexes" (4.50). It then fell below the global cap and is not shortlisted; it
  remains in the artifact.
- **`novelty-unknown` annotations: none.** All three novelty sources were
  reachable for the whole run — `gh` authenticated, 47 open issues with bodies,
  all 400 PRs merged since 2026-06-15, and `docs/roadmap.md`.
- **Cross-theme dedup collapses: none.** One near-adjacency was recorded rather
  than collapsed: pre-release's "abstention census" (per-run aggregation) and
  quality-made-legible's "dark-gate ledger" (accrual over time) are the same
  shape on two time axes. The ledger ranked 4th of 5 in its theme, below its
  cut, so no shortlist entry needed collapsing.
- **Below-cut / below-cap counts:** coverage-evidence-fidelity 8,
  test-intelligence-depth 7, pre-release-confidence 6, adoption-and-onboarding
  8, quality-made-legible 5. All 34 remain reachable in their linked artifacts —
  un-promoted, not destroyed.
- **Thin themes (2).** `pre-release-confidence` generated 9 of 10; the tenth was
  cut at generation as a near-duplicate of `canary-manhunter` (#611).
  `quality-made-legible` generated 5 of 10 after a live surface read against 12
  known existing or proposed items — its artifact states plainly that "the
  shortfall is the result", and that the track is close to saturated at the idea
  level. **No candidate from `quality-made-legible` reached the shortlist**: as
  a thin theme it earns no reserved slot, and its highest entry (6.00) was
  outscored by ten others. That is the honest reading of the most
  heavily-covered track in the repo, not a processing failure.
- **Parked themes: 0. Rejected themes: 0.** No retry was needed.

## Assumptions made

- **Theme derivation.** All 5 themes came from `STRATEGY.md` § Tracks, read via
  `read_strategy` (`present: true, valid: true`). No opportunity areas were
  supplied and none were invented. **No disjointness merges were performed** —
  all 10 pairs of focus lines were compared; two adjacent pairs were kept
  separate on a stated boundary (fidelity = evidence provenance/tier vs depth =
  finding generation from computed signals; depth = statistical signal over
  recorded runs vs pre-release = adversarial driving of live flows).
- **Theme ordering** used a composite of track membership,
  Target-problem/Our-approach touch, and inverse existing-roadmap coverage. The
  coverage input is keyword-grep over `docs/roadmap.md` (`docs/roadmap.d/` does
  not exist in this repo), so it is robust at the extremes and softer in the
  middle band.
- **Pinned date vs real UTC.** The batch date pinned and approved at CONFIRM is
  **2026-09-13**; UTC had already rolled to **2026-09-14** when the workers ran,
  so every per-theme artifact is named and stamped `2026-09-14`. Artifacts
  resolve by frontmatter `topic`, not filename, so verification is unaffected.
  The approved pin is honored for this shortlist's filename rather than silently
  re-pinned.
- **Objection policy `none`** was applied to all five runs: every strongest
  objection in the table above stands as an accepted downside, un-rebutted. Read
  it as part of the pick.
- **Bounds in force:** count 10/theme, cut 3/theme, cap 10 (no reserved-slot
  raise), lookback 90 days, concurrency 2 — never exceeded.
- **Worker isolation.** The orchestrator's own dispatched worktree was removed
  mid-run by the environment; isolation was re-established with six detached
  worktrees off the pinned base before any work proceeded. The shared
  `/Users/bs/Github/canary` checkout was never written to. Each theme worktree
  was released only after its artifact was copied out and verified
  byte-identical by SHA-1.
