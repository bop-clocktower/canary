---
number: 0038
title: Mutation findings are advisory until a measured exit criterion
date: 2026-10-15
status: proposed
tier: medium
source: docs/changes/486-diff-scoped-mutation-testing/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0038 — Mutation findings are advisory until a measured exit criterion

**Status:** proposed **Date:** 2026-10-15 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#486](https://github.com/bop-clocktower/canary/issues/486);
`docs/changes/486-diff-scoped-mutation-testing/proposal.md` (D4, D5, D6; forks
F1-F6); #485 (permanent advisory is an evasion); #527 (precision evidence for
the guardian hard gate); ADR 0009 (exit 3 reserved for "abstained"); ADR 0010
(promote a check once its precision is known); ADR 0011 (required checks are
declared in the repository and never path-filtered); ADR 0037 (what a mutation
report counts); upstream stryker-js#6210

## Context

Coverage and pass counts show that a test ran, not that it would fail if the
code were wrong. #486 records three vacuous tests that passed CI against the
exact bugs they were written to catch, and a run of #472 rounds where the same
class only stopped when someone ran mutants by hand. The #486 spec adds a
diff-scoped mutation check (`canary guardian mutation`, the `mutation` job in
`.github/workflows/guardian.yml`) to produce that evidence.

A new check whose precision nobody has measured cannot be allowed to block
merges (ADR 0010). It also cannot be left advisory forever: #485 is the record
of why an advisory check with no way out becomes permanent wallpaper. And a
mutation run has an obvious false green of its own: "0 survived of 0" reads
exactly like a clean pass, which is the defect class ADR 0009 exists to close.

The spec answered all three questions as D4 (posture), D5 (exit criterion) and
D6 (abstention), and the maintainer signed it off on 2026-09-16 with forks F1-F5
answered as (a) (#486 comment of that date). Its "Architectural decisions"
section says D5 and D6 "should become ADR 0026". That number was taken first by
an unrelated record (ADR 0026, the trustworthy-gate metric from #885), so this
ADR was never written. This record is that ADR, under the number 0038. It
records the signed-off decisions; it does not re-decide them.

Two later facts shape it:

- **The runner cannot kill mutants yet.** The 2026-09-17 spike found that
  `@stryker-mutator/vitest-runner` 10.0.0 runs zero tests per mutant on vitest 5
  (stryker-js#6210), so every covered mutant reads `Survived`. Fork F6(b) built
  the tool-independent parts and keeps the run behind an abstain guard
  (`runnerCompatibility`, `ts/src/guardian/mutation.ts`). It also found that
  suites which call `process.chdir` cannot run in Stryker's worker-thread pool
  and must be excluded, so every report discloses `excludedTests`.
- **ADR 0037 fixes the counting contract.** A `Survived` mutant with no
  `coveredBy` field stays a survivor; only an explicit empty `coveredBy` demotes
  it to `no-coverage` (F1(a)). `Ignored`, `CompileError`, `RuntimeError` and
  `Pending` mutants are left out of `sampled` and `noCoverage` and counted in a
  new disclosed `untested` count (F2(a)).

## Decision

**D4: posture.** The mutation check is advisory. Survivors produce warning
annotations and a `### Mutation` report section, and the CI job exits 0 on
survivors. The command underneath keeps the full ADR 0009 contract (0
all-killed, 1 survivors, 3 abstained); only the CI wrapper turns 1 and 3 into a
non-blocking step. The `mutation` job is listed under `advisory` in
`.github/required-checks.json` with its reason, and it must not appear in the
`required` list until D5 is met.

**D5: exit criterion to gating.** The check is promoted to a required gate once
20 consecutive PRs that produced mutants show:

1. a false-survivor rate of 10% or less, measured by human triage of the
   reported survivors; and
2. a p90 mutation-job wall-clock time within the 10-minute budget (spec D7).

The `mutation-report.json` artifact each run uploads is the evidence source; the
rate and p90 are computed from those artifacts without re-running anything (spec
success criterion 7). Promotion is a change to this ADR's status or a successor
ADR, plus the ADR 0011 procedure: move the entry to `required`, apply the
ruleset, and make the CI wrapper stop converting exit 1 to 0. The thresholds are
starting values (spec A3). They may be revised by amending this ADR before the
evidence window starts, and not while it is running.

**D6: abstention.** A mutation run reports `abstained` with a stated reason, and
the command exits 3, when any of the following holds:

- zero mutants were generated (a docs-only diff, or added lines that are all
  type-only);
- zero mutants were tested (see the assumption on `untested` below);
- no tested mutant was covered by any test, so nothing could be killed;
- Stryker crashed or timed out, or the runner guard judged the installed runner
  unable to kill a mutant (stryker-js#6210);
- the diff, or the Stryker report, is missing or unreadable.

An abstention is never rendered as "0 survived", never counted as a pass, and
never counted as a PR that "produced mutants" for D5. The excluded-tests
disclosure is printed on abstentions too.

## Consequences

- Authors get concrete, named weak-assertion evidence on their PR without a new
  way for an unmeasured check to block a merge.
- The advisory status has a written, measurable end. Leaving it advisory after
  the window is met, or promoting it before, both require amending this record.
- Abstentions stay loud. Today every run abstains, because the runner guard
  holds (stryker-js#6210), so the D5 window has not started and zero PRs have
  been counted. That is the honest state, not progress toward promotion.
- The false-survivor rate carries a known bias: a mutant that only an excluded
  thread-unsafe suite would kill reads as `survived` (spec A2). Those count
  against the rate, so the D5 threshold cannot be met by ignoring them. The
  disclosure on every report is what makes that bias visible.
- Spec success criteria 1, 3 and 7 cannot be evidenced until a runner that kills
  mutants is pinned, which also gates the start of the D5 window.

### Where the shipped code differs from the spec

Recorded as fact; nothing here is changed by this ADR.

- **No sticky section or per-line annotations.** D4 and the spec's Output
  section describe a `### Mutation` section in the guardian sticky comment and
  one `::warning file=…,line=…` per survivor. The shipped job prints the section
  to the step log (`renderMutationReport`, `ts/src/guardian/mutation-report.ts`)
  and emits a single summary `::warning` for exit 1 or 3
  (`.github/workflows/guardian.yml`, the `Mutation report` step). The guardian
  sticky comment does not include it.
- **Crash and timeout are job states, not reports.** The wrapper passes any exit
  code other than 1 or 3 straight through, so a crash fails the (advisory) job
  rather than writing an `abstained` report. A run that hits
  `timeout-minutes: 10` is cancelled by GitHub and writes no report. Both are
  visible, but neither yields the `abstained`-with-reason artifact D6 describes.
- **Not diff-scoped yet.** `canary guardian mutation` maps whatever Stryker
  report it is given; the diff-scope builder was removed until a runner is wired
  (`ts/src/guardian/mutation.ts` header). Without `--report` it always abstains,
  so the "missing diff" condition is currently subsumed by that path.
- **Stricter than the spec on timeouts.** The spec abstains when every mutant is
  `no-coverage`. The shipped `verdictFor` abstains whenever nothing was killed
  and nothing survived, which also covers a run whose mutants only timed out.
  That is consistent with D6's intent.
- **Pre-ADR 0037 counting.** `toStatus` currently treats a missing `coveredBy`
  like an empty one and maps every unrecognised Stryker status to `no-coverage`.
  ADR 0037 owns that change.

### Assumptions made

- **Zero tested mutants abstains (derived from ADR 0037's F2(a)).** Mutants in
  `untested` were not tested. A run in which every generated mutant is
  `untested` has `sampled` of 0 and must abstain, never read as `all-killed`.
  Its reason must name the `untested` count rather than say "zero mutants",
  because mutants were generated.
- **"Mutant-producing PR" means a run that did not abstain** (verdict
  `survivors` or `all-killed`). Abstained runs neither count toward the 20 nor
  break the run of consecutive PRs; they are not evidence either way.
- **The window is the most recent 20 mutant-producing PRs**, and the rate is
  pooled over it: false survivors divided by all survivors reported in those 20
  runs.
- **Unattributed survivors count.** Under ADR 0037's F1(a) a survivor can lack a
  `coveredBy` field. It is triaged like any other survivor and is in the D5
  denominator. Missing attribution makes triage slower; it does not change
  whether the mutant survived.
- **Suppressed survivors are triaged too.** A `// canary:allow-mutant <reason>`
  survivor stays in the D5 denominator, and one whose reason amounts to an
  equivalent mutant counts as a false survivor, so suppressing cannot improve
  the measured rate.
- **The budget is the job's wall-clock time** as recorded in the artifact or the
  job run, against D7's 10-minute cap.

## Alternatives Considered

- **Gate immediately.** Blocks on day one, but on an unmeasured precision
  (ADR 0010) and, today, on a runner that reports every covered mutant as
  survived. Rejected.
- **Stay advisory with no exit criterion, or time-box it to 30 days whatever the
  evidence (F5(c)).** The first is the permanent-advisory drift #485 warns
  about; the second promotes on the calendar, not on evidence. Rejected.
- **Stricter thresholds: 50 PRs at 5% or less (F5(b)).** More confidence, but
  for a repo of this size the window would take long enough to drift into
  permanent advisory again. Rejected as the starting point; the thresholds can
  still be tightened before the window starts.
- **Treat zero mutants, or zero tested mutants, as a pass.** Simpler, and
  exactly the "0 of 0" false green ADR 0009 forbids. Rejected.
