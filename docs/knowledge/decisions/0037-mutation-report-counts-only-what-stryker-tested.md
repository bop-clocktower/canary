---
number: 0037
title: The mutation report counts only what Stryker tested, and all of it
date: 2026-10-15
status: proposed
tier: medium
source: docs/changes/486-diff-scoped-mutation-testing/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0037 — The mutation report counts only what Stryker tested, and all of it

**Status:** proposed **Date:** 2026-10-15 **Deciders:** Bri Stevenski
(maintainer) **Related:** PR #1302; issue #1306 (repro branch
`repro/bf-mutation-untested-statuses`);
`docs/changes/486-diff-scoped-mutation-testing/proposal.md` (success criterion
2, D6, D7, F3, F4); ADR 0009 (exit 3 reserved for "abstained"); ADR 0026 (a
metric is disclosed as partial rather than read as whole); ADR 0038 (sibling:
mutation findings stay advisory until a measured exit criterion, and what
mutation abstention means)

## Context

`mapStrykerReport` (`ts/src/guardian/mutation-report.ts`) turns a Stryker JSON
report into a `MutationReport` (`ts/src/guardian/mutation.ts:81`). bug-fleet
area A5 found two cases where the counts misstate what the run did. Both are in
`toStatus` (`mutation-report.ts:48`).

1. **A survivor with no `coveredBy` field.** `mapStrykerReport` turns an absent
   `coveredBy` into `[]` (`mutation-report.ts:124`). `toStatus` then applies the
   #486 success criterion 2 rule, "a survivor with empty `coveredBy` is
   classified as `no-coverage`", and demotes the survivor. Stryker writes
   `coveredBy` only under `coverageAnalysis: perTest`. Under `all` or `off`,
   every survivor lacks the field even though Stryker ran the suite against it
   and the mutant lived. A run with one killed mutant and any number of real
   survivors therefore reports `all-killed` and exits 0. That is the false green
   #486 exists to prevent. PR #1302 fixes it, and pr-fleet held it because it
   reverses success criterion 2 as written.
2. **Mutants that never ran a test.** `toStatus` sends every status it does not
   name to its default branch, which returns `no-coverage`. That includes
   Stryker's `Ignored`, `CompileError`, `RuntimeError` and `Pending`. Those
   mutants are also counted in `sampled`, because `sampled` is `findings.length`
   (`mutation-report.ts:141`). The headline `killed/sampled` therefore has
   mutants in its denominator that no test was ever run against. The trailer "N
   mutant(s) had no covering test" (`mutation-report.ts:262`) then calls a
   mutant that failed to compile a coverage gap. Issue #1306 reproduces this:
   one Killed mutant plus one each of `Ignored`, `CompileError` and
   `RuntimeError` reports `noCoverage: 3`.

Both cases break one rule. A mutation count should describe the mutants a test
was actually run against, and every mutant Stryker reported should land in a
count that a reader can see. Case 1 hides tested survivors. Case 2 adds untested
mutants to the denominator. ADR 0026 is the precedent: a metric that covers less
than it appears to is disclosed as partial and kept, not reinterpreted silently.

## Decision

`MutationReport` counts by what Stryker did to each mutant.

**F1: an absent `coveredBy` is unattributed, not uncovered.**

- A `Survived` mutant with **no** `coveredBy` field stays `survived`. It counts
  in `survived`, sets the verdict to `survivors`, and drives exit 1 (ADR 0009).
- Only an **explicit** empty `coveredBy: []` demotes a `Survived` mutant to
  `no-coverage`. That is the case success criterion 2 was written for.
- `MutantFinding.coveredBy` keeps its `string[]` type. For an unattributed
  survivor it is `[]`. After this rule, a `survived` finding with an empty
  `coveredBy` can only mean "attribution was not recorded", so the shape stays
  unambiguous without a new field.
- **Disclosure.** The rendered survivor line for such a finding says that
  attribution was not recorded. It does not say "no covering test", which would
  claim a coverage gap that was never measured. The `### Mutation` section also
  carries one line under the headline that counts the unattributed survivors and
  points at `coverageAnalysis: perTest` as the way to name their tests.
- #486 success criterion 2 is **amended**. Attribution may be absent. When it
  is, the absence is reported, and the survivor is not demoted.

**F2: mutants that never ran a test are counted apart, in `untested`.**

- A mutant whose Stryker status is `Ignored`, `CompileError`, `RuntimeError` or
  `Pending` is **excluded** from `sampled`, from `noCoverage` and from every
  other tested tally (`killed`, `survived`, `timeout`).
- It is counted in a new, additive `untested: number` field on `MutationReport`.
  `untested` is always present, zero included, on every report, abstentions
  included (`abstainedReport` sets it to `0`).
- It is not emitted as a `MutantFinding`, and `MutationStatus` gains no value.
  The count is the disclosure.
- The renderer prints the `untested` line unconditionally, the same way it
  already prints the timeout line (`mutation-report.ts:245`), so a reader never
  infers that a clean run had none.
- **Counting identity.** `sampled` is the number of mutants a test was run
  against: `sampled = killed + survived + noCoverage + timeout` before
  suppressions. `sampled + untested` is the number of mutants in the Stryker
  report. `generated` keeps its meaning (D7): mutants Stryker generated before
  the cap.

**What this ADR does not decide.** When a report abstains, what the abstention
reason says, and whether mutation findings ever gate a PR are ADR 0038's (#486
D5 and D6). This ADR only fixes what the inputs to those rules count. For
example, if every mutant is untested, `sampled` is 0. ADR 0038 decides how that
abstains and what the reason says.

## Consequences

- **#1302 becomes landable after sign-off.** Its code change is exactly F1's
  counting rule. The disclosure rendering in F1 ships with it or in a tracked
  follow-up before the D5 evidence window counts the run.
- **#1306's fix must add the `untested` field.** That is a schema change to
  `MutationReport` and to the `mutation-report.json` artifact that
  `.github/workflows/guardian.yml` uploads. The change is additive, so an older
  reader that ignores unknown keys keeps working. #1306's PR must also add a
  consumer note to the #486 docs: `untested` exists, it is outside `sampled`,
  and `sampled + untested` is the report's mutant total. The #1306 repro test
  (`noCoverage` is 0 for those statuses) becomes the regression test, with an
  added assertion on `untested` and `sampled`.
- **Consumer gates that read `noCoverage` or `sampled` see different numbers.**
  `noCoverage` drops by the untested mutants and by survivors that only lacked
  attribution. `sampled` drops by the untested mutants. `survived` can rise
  where Stryker ran without `perTest`. A consumer gate that exited 0 on such a
  run can now exit 1. That is the intended correction of a false green, but it
  is a visible behaviour change, and the release notes for the version that
  ships F1 must say so. Inside canary, `guardian mutation` reads the verdict
  through `mutationExitCode` (`ts/src/guardian/cli.ts:1533`), and the `mutation`
  job stays advisory (#486 success criterion 6). No required check changes.
- **The D5 false-survivor evidence gets cleaner.** Untested mutants no longer
  dilute the denominator, and unattributed survivors are triaged as survivors
  rather than vanishing into `no-coverage`. Runs recorded before this ADR are
  not comparable on `noCoverage` or `sampled`.
- **F3's rationale is worded against the old rule.** It says skill scripts
  "would abstain as `no-coverage`" without perTest attribution. Under F1 they
  would report unattributed survivors instead. F3's decision ((a), `ts/src`
  only) still stands. Only the reason now reads "survivors could not name their
  tests". The proposal text is left as written, and this ADR is the record.

### Assumptions made

- **Unattributed-survivor disclosure.** It is shown as "attribution not
  recorded" on the survivor line, plus one headline-adjacent count that points
  at `coverageAnalysis: perTest`. No new field or `MutationStatus` value is
  added, because the human rejected a separate `unattributed` category at
  CONFIRM.
- **`untested` is a single count with no per-status breakdown.** A breakdown
  (for example `compileError: n`) can be added later without breaking consumers.
- **Untested mutants are not emitted as findings.** Their locations are not in
  the report. A reader who needs them reads Stryker's own JSON.
- **`generated` is unchanged.** The renderer's "sampled N of M" scope note
  (`mutation-report.ts:238`) must not attribute an `untested` gap to the D7 cap.
  #1306's implementation words the headline so that the cap and the untested
  mutants are disclosed separately.
- **The Stryker status list is closed at four.** Any status Stryker adds later
  that never runs a test joins `untested`, not `no-coverage`. `NoCoverage` keeps
  its current mapping to `no-coverage`.

## Alternatives Considered

- **F1(b): keep success criterion 2 as written.** This keeps the code consistent
  with the spec, but leaves the false `all-killed` for every run without perTest
  coverage. Rejected.
- **F1(c): a new `unattributed` category.** This is explicit, but it adds a
  `MutationStatus` value and a count that every consumer and the D5 triage would
  have to learn. A `survived` finding with empty `coveredBy` already carries the
  same meaning once the explicit-empty case is demoted. Rejected.
- **F2(b): drop untested mutants with no field.** The denominator would be
  honest, but the mutants would vanish. A run where most mutants failed to
  compile would read as a small clean run. That is the silent-abstention shape
  ADR 0026 rejects. Rejected.
- **F2(c): leave untested mutants as `no-coverage`.** This keeps the false
  denominator and the false coverage-gap message from #1306. Rejected.
