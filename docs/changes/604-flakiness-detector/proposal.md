# Cross-run flakiness: close the gaps the existing history surfaces leave open (#604)

**Keywords:** flakiness, alternation, flip-rate, run-history, sample-size,
abstention, canary-history, canary-analyze, ci-ready

> **Status: spec only.** This proposal came out of a roadmap-fleet run where a
> human said "spec only". Nobody has signed it off, and it contains no code, no
> tests, no skill files and no CLI wiring. The defaults marked _assumption_ were
> chosen without asking anyone (harness-brainstorming was run non-interactively;
> its EVALUATE questions became the Decisions for the human at the end).

## Overview

Issue #604 asked for "a skill that ingests N test-reporter run JSON artifacts
and statistically flags flaky tests (pass/fail alternation)". Its roadmap row
was later corrected: run history is already persisted and queried. So this spec
starts with a gap analysis against the code on `main` (read at `e1e8e55`, not
taken from the docs), and specifies only what is missing.

**Short answer:** most of #604 already ships. It should **not** become a new
skill. Two real gaps remain, and both produce false greens:

1. **Cross-run alternation is invisible.** Every flake surface counts only the
   `flaky` status, which is a retry _inside_ one run. The vitest reader never
   writes that status (`ts/src/history/formats/vitest-report.ts:5-6,120`). So a
   test that goes passed, failed, passed, failed across runs has
   `flake_count: 0` and shows up nowhere.
2. **A thin window reads as healthy.** `canary ci-ready` returns
   `verdict: 'pass'` with the reason `0 flaky tests across 2 run(s)`
   (`ts/src/core/ci-ready.ts:94-99`). `canary history flaky` prints a green
   `No tests above 10.0% flake rate in the last 30 runs.` even when the store
   holds 2 runs (`ts/src/history/cli.ts:543-549`).

So the recommendation is to **extend** existing commands. An abandoned
work-in-progress branch, `feat/604-cross-run-alternation` (commit `df06d3a`,
red, no PR), already holds a unit-tested alternation core. The build lane should
start from it, not from scratch.

## Gap analysis

### What exists today (verified in code)

| Capability                   | Entry point                                                                                                                                                 | What it actually computes                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Persistence                  | `canary history record <results>` (`ts/src/history/cli.ts:788`), `push` (`:772`); readers in `ts/src/history/formats/` (vitest, Playwright, JUnit)          | Appends one `RunRecord` per run to `history-v2.jsonl` (NDJSON store) or Supabase                                                  |
| Within-run flake status      | Playwright reader (`playwright-report.ts:127-128`), JUnit reader (`junit-report.ts:185,226`)                                                                | `flaky` = failed then passed on retry. vitest: never (`flaky: 0`)                                                                 |
| Flake-rate query             | `canary history flaky` (`cli.ts:819`), `canary analyze flaky` (`ts/src/analysis/cli.ts:688`) → `queryFlaky` (`ndjson-store.ts:122`, `supabase-store.ts:91`) | `flake_count / total_runs` per test over the last N runs; counts only, no ordered sequence (`applyStatus`, `ndjson-store.ts:206`) |
| Per-test timeline            | `canary history timeline` (`cli.ts:839`) → `queryTimeline`                                                                                                  | Time-ordered status list for one named test                                                                                       |
| Trend classification         | `classifyFlakeTrend` (`ts/src/history/detector.ts:19`)                                                                                                      | Mean flake rate of 2nd half minus 1st half vs 0.1. **No production caller** (only `detector.test.ts`)                             |
| Regression (one-way break)   | `detectRegressions` (`detector.ts:47`) via `canary analyze regression-candidates` (`analysis/cli.ts:793`, `engine.ts:233`)                                  | Green streak of at least 5, then the last 3 failed                                                                                |
| Cross-suite correlation      | `canary analyze common-failures --min-suites 2` (`analysis/cli.ts:775`)                                                                                     | Tests failing in several suites                                                                                                   |
| Failure spikes               | `canary analyze spikes` (`analysis/cli.ts:723`)                                                                                                             | Pass-rate delta between windows                                                                                                   |
| CI-run flakes                | `canary analyze gh-flaky` (`analysis/cli.ts:744`, `ts/src/analysis/gh-flaky/gh-run-attempts.ts`, #884)                                                      | Same-SHA flips and re-run attempts at workflow level; names verdicts `verified-zero` / `abstained` / `flake-signal-unverifiable`  |
| CI-readiness flakiness check | `scoreFlakiness` (`ts/src/core/ci-ready.ts:80`)                                                                                                             | Same `flaky`-status rate, 30-run window, fail at 10%                                                                              |
| Empty-store abstention       | `abstainOnEmptyHistory` (`history/cli.ts:75`)                                                                                                               | Zero runs → advisory abstention, not a pass                                                                                       |
| Fleet-wide summary skill     | `agents/skills/claude-code/canary-fleet-health/SKILL.md`                                                                                                    | Wraps `canary analyze` into one screen                                                                                            |
| Diagnose one known flake     | `canary-flake-hunter` agent / `canary-debug-flake`                                                                                                          | Root cause for a single suspected test                                                                                            |
| Quarantine or revert advice  | `canary-screech` skill (broken-main siren)                                                                                                                  | Quarantine-or-revert for a red default branch                                                                                     |

### Gap table

| #   | Capability #604 asks for                          | Exists today                                                              | Gap                                                                                                            | In scope?                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| G1  | Pass/fail alternation across runs                 | No. WIP core only on `feat/604-cross-run-alternation`                     | `queryFlaky` keeps counts, not an ordered sequence, so alternation cannot be computed at the store layer       | **Yes**                                    |
| G2  | Minimum sample size / thin-window disclosure      | Zero-run abstention only                                                  | 1 to N-1 runs report a confident pass or a green "no tests above" line; the window actually read is not stated | **Yes**                                    |
| G3  | Honest zero for suites that cannot report `flaky` | No                                                                        | A vitest-only store reads as "0 flaky" structurally, not by measurement                                        | **Yes**                                    |
| G4  | Alternation on the Supabase backend               | No                                                                        | The Supabase `queryFlaky` has no sequence either; its rows must read as UNKNOWN, not clean                     | **Yes** (disclose only; no SQL work in v1) |
| G5  | Trend classification surfaced to users            | `classifyFlakeTrend` exists, unwired                                      | No command calls it                                                                                            | No (Decision H4)                           |
| —   | Cross-suite correlation                           | `analyze common-failures`                                                 | None                                                                                                           | Delivered                                  |
| —   | Quarantine recommendations                        | `canary-screech`; ci-ready counts quarantined-with-issue as verified      | None for #604's purpose                                                                                        | Non-goal                                   |
| —   | A new skill ingesting run JSON                    | Store, queries and `canary-fleet-health` cover ingestion and presentation | None                                                                                                           | Non-goal                                   |

**Count:** 5 gaps found (G1-G5), 4 in scope.

## Decisions made

| #   | Decision           | Choice                                                                                                                                                                              | Rationale                                                                                                                        |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Shape              | Extend `queryFlaky` rows and the three existing flake surfaces (`history flaky`, `analyze flaky`, `ci-ready` flakiness). No new skill, no new command                               | The row's own rescope note. Every consumer (including `canary-fleet-health`) inherits it for free.                               |
| D2  | Alternation metric | Reuse the WIP definition: flips between consecutive _definitive_ outcomes (`passed`/`failed`); `flaky` and `skipped` are not observations. `flip_rate_pct = flips / (observed − 1)` | Already reviewed and unit-tested on the WIP branch. Skipping non-outcomes stops `p, skip, p` from inventing a flip.              |
| D3  | Flip floor         | `MIN_ALTERNATION_FLIPS = 2` (changed and changed back)                                                                                                                              | One flip is a step change that `detectRegressions` owns. Without the floor, every fresh regression would be reported as a flake. |
| D4  | Ranking            | Sort by `max(flake_rate_pct, flip_rate_pct)`                                                                                                                                        | So an alternator is not buried under retry-flakes (from the WIP checkpoint note).                                                |
| D5  | Minimum sample     | A test needs at least **8 definitive observations** before it can be reported as _not_ alternating; a suite window needs at least **10 runs** before a clean result can be `pass`   | With fewer, a 2-flip pattern cannot be told apart from noise, and "0 of 2" is an abstention. _Assumption_; see Decision H2.      |
| D6  | Thin window        | Below the minimum: `verdict: 'warn'` with the reason `insufficient history: N of 10 runs`, never `pass`. Human output always states `read N runs (window W)`                        | ADR 0009 (no silent abstention). Warn rather than skip, so the check stays visible.                                              |
| D7  | Structural zero    | When no run in the window came from a reader that can emit `flaky`, the retry-flake half reports `not measurable (vitest has no flaky status)` instead of `0`                       | G3. Record the source reader per run if it is not already derivable; see Technical design.                                       |
| D8  | Supabase           | Alternation fields absent → rendered `UNKNOWN (backend does not measure alternation)`. Any clean verdict over such rows is at most `warn`                                           | G4. Same pattern as the `degraded` sections in `engine.ts` (#711).                                                               |
| D9  | Posture            | Advisory, like the rest of `canary analyze`. `ci-ready` keeps its existing fail threshold (10%), applied to `max(flake, flip)`                                                      | No new gate. Promotion would be a separate change.                                                                               |

### Approaches considered

1. **Extend existing rows and surfaces (chosen).** Low complexity, reuses the
   WIP core, and one fix reaches every consumer. The cost: `FlakyQueryRow` grows
   two optional fields, and the NDJSON query keeps an ordered sequence (memory
   is O(tests × window); the window is capped at 30 by default).
2. **A new `canary analyze alternation` command plus a skill.** Cleaner
   separation, but a second flake ranking that disagrees with the first, a new
   CLI surface (which trips the perf delta ratchet), and a new skill the issue's
   own rescope rejected. Medium complexity.
3. **Close #604 as delivered and file only the thin-window fix.** Smallest, but
   it leaves G1 open, and G1 is the population #604 was filed for. The issue
   fleet already rejected that closure once, on exactly this ground.

## Technical design

### Data (inputs from the history store)

Per `RunRecord` (NDJSON: `history-v2.jsonl`): `run_id`, `suite`, `timestamp`,
`tests[]`. Per test: `test_name`, `test_file`, `suite`, `area`, `status`
(`passed` | `failed` | `flaky` | `skipped`), `retry_count`. No schema change is
needed for G1, G2 or G4.

G3 needs to know whether a run's reader could emit `flaky`. Preferred: derive it
from an existing run-level field, if one records the source format. If none
does, add an optional `reporter_format` to `RunInput` at record time; unstamped
legacy rows count as "unknown capability" (disclosed, never assumed). The build
lane must check `schema.ts` before choosing; a schema change goes through
`resolveSchemaVersion` (#701).

### Outputs

`FlakyQueryRow` gains:

- `flip_count?: number`, `flip_rate_pct?: number`, `observed?: number`
  (definitive observations).
- `alternating?: boolean` (D2 and D3 applied with `minRatePct`).

A new result envelope wraps the rows. JSON output changes from a bare array to
`{ window_requested, runs_read, sufficient, rows, disclosures[] }`. This is a
breaking change to `--json`; see Decision H3.

Human output adds a header line `read N runs (window W)`. Below the minimum, the
green "No tests above..." line becomes a yellow
`insufficient history: N of 10 runs — no flake verdict`.

`ci-ready` `scoreFlakiness` uses the same rows. Verdicts:

| Condition                                           | Verdict | Reason text (shape)                                   |
| --------------------------------------------------- | ------- | ----------------------------------------------------- |
| 0 runs                                              | skip    | unchanged                                             |
| 1-9 runs, nothing found                             | warn    | `insufficient history: N of 10 runs`                  |
| any test at or above 10% on `max(flake, flip)`      | fail    | names the worst test and which axis                   |
| findings below 10%                                  | warn    | unchanged shape                                       |
| at least 10 runs, nothing found, flaky measurable   | pass    | `0 flaky or alternating tests across N run(s)`        |
| at least 10 runs, nothing found, flaky unmeasurable | pass    | as above, plus `retry flakes not measurable (vitest)` |

### Where it lives

- `ts/src/history/detector.ts`: cherry-pick `detectAlternation`,
  `isAlternating`, `MIN_ALTERNATION_FLIPS` from `df06d3a`.
- `ts/src/history/ndjson-store.ts`: sequence accumulation in `queryFlaky`.
- `ts/src/history/supabase-store.ts`: no query change; rows lack the fields.
- `ts/src/history/cli.ts`, `ts/src/analysis/cli.ts`, `analysis/reports.ts`:
  rendering and envelope.
- `ts/src/core/ci-ready.ts`: `scoreFlakiness` reads the shared computation
  instead of its private `flakeRates`, so the two stop drifting.
- `agents/skills/claude-code/canary-fleet-health/SKILL.md`: output example and a
  line on reading `UNKNOWN` / insufficient history.

## Integration points

### Entry points

No new commands, MCP tools or skills. Changed: `canary history flaky`,
`canary analyze flaky`, `canary analyze digest` (flaky section),
`canary ci-ready` flakiness check.

### Registrations required

None. No new module means no new `entropy.entryPoints` entries. No new CLI
surface means no perf delta allowance.

### Documentation updates

`canary-fleet-health` SKILL.md; CLI reference for the `--json` envelope;
CHANGELOG (breaking `--json` shape, if Decision H3 keeps the envelope).

### Architectural decisions

None rises to a new ADR. D5/D6 apply ADR 0009 rather than change it.

### Knowledge impact

Domain terms: _retry flake_ (within-run `flaky` status) vs _alternator_
(cross-run flips); _structural zero_.

## Success criteria

Statistical honesty and abstention (the criteria the whole spec exists for):

- **SC1 (denominator).** When the store holds 1-9 runs in the requested window
  and no test crosses a threshold, `canary ci-ready` shall report the flakiness
  check as `warn` with a reason containing `insufficient history` and the run
  count, and shall not report `pass`.
- **SC2 (denominator).** When `canary history flaky` or `canary analyze flaky`
  reads fewer runs than the minimum, the human output shall not contain the
  green "No tests above" line, and `--json` shall carry `sufficient: false` and
  `runs_read: N`.
- **SC3.** Every human flaky output shall state `read N runs (window W)`.
- **SC4 (structural zero).** Given a store where every run came from the vitest
  reader, output shall say retry flakes are not measurable rather than
  `0 flaky`.
- **SC5 (UNKNOWN).** Given the Supabase backend, alternation columns shall
  render `UNKNOWN`, and no clean verdict over them shall be `pass`.

Detection:

- **SC6.** Given 10 runs where test `suite-alpha > renders widget` alternates
  `passed, failed` every run and is never `flaky`, both flaky commands shall
  list it with `flip_count: 9`, `alternating: true`.
- **SC7.** Given 10 runs of `passed ×7, failed ×3`, the test shall not be
  `alternating` (1 flip < floor) and shall still appear in
  `regression-candidates`.
- **SC8.** `passed, skipped, passed` shall yield `flip_count: 0`.
- **SC9.** Ranking: an alternator at 60% flips shall sort above a retry-flake at
  20%.
- **SC10.** `ci-ready` fails when any test's `max(flake, flip)` is at or above
  10% over at least 10 runs.

Non-regression:

- **SC11.** Existing `flake_rate_pct` values are unchanged for every existing
  fixture in `ndjson-store.test.ts`.
- **SC12.** The four gates (build, typecheck, format:check, test) pass from
  `ts/`, with no allowance or baseline edits.

## Implementation order

Two PRs.

1. **Phase 1: honesty (G2, G3, G4 disclosure).** Envelope, `runs_read`,
   insufficient-history `warn`, structural-zero and UNKNOWN wording. SC1-SC5,
   SC11. Ships value even if Phase 2 slips, because it removes today's false
   greens.
2. **Phase 2: alternation (G1).** Cherry-pick the WIP detector, sequence
   accumulation, ranking, `ci-ready` on `max(flake, flip)`, fleet-health doc.
   SC6-SC10, SC12. Delete `feat/604-cross-run-alternation` once merged.

## Non-goals

- A new skill or command, including a themed name.
- Quarantine automation or recommendations (`canary-screech` owns that).
- Supabase SQL that computes flips server-side (disclosed as UNKNOWN in v1).
- Wiring `classifyFlakeTrend` (Decision H4).
- Statistical tests beyond the flip floor and sample minimum (no Wald–Wolfowitz
  runs test, no confidence intervals) in v1.

## Accepted risks

- **Breaking `--json` shape** for the two flaky commands (Decision H3).
- **Minimums are guesses.** 8 observations and 10 runs are _assumptions_. They
  trade early detection for fewer false reports.
- **Ordering by timestamp.** Runs recorded out of order (backfill) make the
  sequence, and so the flips, wrong. The NDJSON store reads in append order; the
  build lane must sort by `timestamp` first, as `queryTimeline` does.
- **Real intermittency vs. an environment flip.** A suite whose environment
  alternates will look like many alternators at once. `common-failures` and
  `spikes` remain the tool to spot that; this spec does not correlate them.

## Assumptions

- Minimum sample is 10 runs per window and 8 definitive observations per test.
- Flip floor is 2, taken from the WIP branch.
- Below the minimum, the verdict is `warn`, not `skip`.
- `ci-ready`'s 10% threshold applies to `max(flake_rate_pct, flip_rate_pct)`.
- Supabase stays count-only in v1 and is disclosed as UNKNOWN.
- The `--json` envelope replaces the bare array.

## Decisions for the human

| #   | Decision                                      | Options                                                                                                       | Recommended default                                                                                                                  |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | Route for #604                                | (a) extend existing surfaces, (b) new command plus skill, (c) close as delivered with a thin-window follow-up | **(a) extend.** Do not close: G1 is the exact population #604 was filed for, and intake already rejected closure once on that basis. |
| H2  | Minimum sample                                | 5 / **10** / 20 runs; 8 observations per test                                                                 | **10 runs, 8 observations**                                                                                                          |
| H3  | `--json` shape                                | (a) envelope object (breaking), (b) keep bare array and add a stderr disclosure plus per-row `observed`       | **(a) envelope.** A disclosure a machine cannot read gets dropped by every JSON consumer; ship it in the next major.                 |
| H4  | `classifyFlakeTrend` has no production caller | (a) leave as is, (b) wire into `analyze flaky` as a column, (c) delete as dead code                           | **(a) leave**, and file a separate dead-code issue; out of scope here.                                                               |
| H5  | Naming                                        | Themed name or none                                                                                           | **None.** No new skill is created. Do not reuse `canary-misfit`: it is now reserved for #592.                                        |
| H6  | Phase split                                   | One PR or two                                                                                                 | **Two** (honesty first).                                                                                                             |
| H7  | WIP branch `feat/604-cross-run-alternation`   | Build on it or restart                                                                                        | **Build on it** (cherry-pick the detector commit only; its store and CLI tests target fields this spec reshapes).                    |
