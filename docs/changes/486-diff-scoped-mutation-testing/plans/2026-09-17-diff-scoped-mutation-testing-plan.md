# Plan: Diff-scoped mutation testing, tool-independent slice (#486)

**Date:** 2026-09-17 | **Spec:** [proposal.md](../proposal.md) | **Tasks:** 9 |
**Time:** ~35 min | **Integration Tier:** medium

## Goal

Ship everything about diff-scoped mutation testing that does not depend on a
working StrykerJS runner — scope derivation, report mapping, abstention,
suppression, the `canary guardian mutation` subcommand and an advisory CI job —
with the Stryker execution itself behind an abstain guard, so the check can
never print a survivor it cannot trust.

## Why this slice, and not the spec's

The spec's implementation step 1 (the throwaway spike) ran on 2026-09-17 and
falsified assumption A1. Fork F6, recorded on
[issue #486](https://github.com/bop-clocktower/canary/issues/486#issuecomment-5719036832),
answered it as **(b): build the tool-independent parts now, keep the Stryker run
behind an abstain guard.** The two spike findings are written into the spec's
Assumptions section (A1, A2).

## Observable Truths (Acceptance Criteria)

Each maps to a spec success criterion (SC-n) where one exists.

1. **[ADDED]** When the guardian is handed a diff, the system shall emit one
   Stryker `mutate` entry per added line range under `ts/src/`, skipping test,
   type-only and skip-glob units. (Spec D2.)
2. **[ADDED]** While the installed `@stryker-mutator/vitest-runner` is a version
   whose per-test name filter is broken on the installed vitest major, the
   system shall report `abstained` with a reason naming `stryker-js#6210`, and
   shall not report any mutant as `survived`. (SC-4, F6.)
3. **[ADDED]** If a mutation run generates zero mutants, or every mutant is
   `no-coverage`, or Stryker crashes, or the diff is missing, then the system
   shall report `abstained` with the reason and exit 3 locally — never "0
   survived" and never exit 0. (SC-4, D6, ADR 0009.)
4. **[ADDED]** The system shall report every headline with its denominator
   (`killed/sampled`), and shall state `sampled N of M` whenever the mutant cap
   truncated the run. (SC-3's honesty half, D7, F4.)
5. **[ADDED]** Where a survivor's line carries
   `// canary:allow-mutant <reason>`, the system shall list it as suppressed
   with its reason and shall exclude it from the `survived` count; a marker with
   no reason is ignored. (SC-5, D9.)
6. **[ADDED]** The system shall classify a mutant with an empty `coveredBy` as
   `no-coverage`, never as `survived`. (SC-2.)
7. **[ADDED]** Every report — including every abstention — shall disclose the
   thread-unsafe test files excluded from the mutation run (`excludedTests`).
   (F6, spec A2.)
8. **[ADDED]** `canary guardian mutation` shall exit 0 when all sampled mutants
   were killed, 1 on survivors, and 3 on abstention.
9. **[ADDED]** The `mutation` job in `guardian.yml` shall never fail the PR on
   survivors and shall not appear in `.github/required-checks.json`. (SC-6, D4.)
10. The four gates pass from `ts/`: `npm run build`, `npm run typecheck`,
    `npm run format:check`, `npm test`.

Not deliverable in this slice, and deliberately unclaimed: SC-1 (the #484
regression case), SC-3's p90 measurement and SC-7 (the 20-PR evidence window).
All three need a runner that actually kills mutants.

## Uncertainties

- [ASSUMPTION] The version guard's compatible-version predicate is
  `vitest-runner > 10.0.0 || vitest major < 5`. 10.0.0 is the newest release and
  stryker-js#6210 is open, so anything newer is assumed to carry the fix; the
  guard is data, in one exported constant, so revising it is a one-line change.
- [ASSUMPTION] The mutation job posts its own sticky comment marker rather than
  a section inside guardian's, because it is a separate job from `pr-check` and
  the two cannot share one comment body without one job overwriting the other.
  The spec's "`### Mutation` section" (D-Output) is honored as a section heading
  inside that separate sticky.
- [ASSUMPTION] No StrykerJS dependency is added in this slice. The guard
  abstains on an absent runner, so pinning a package the shipped code never
  executes would add ~2.4k lockfile lines and 2 moderate `qs` advisories for no
  behavior. The pins land in the follow-up that turns the runner on.
- [DEFERRABLE] `ts/vitest.mutation.config.ts` (the thread-unsafe exclusion
  config Stryker consumes) also lands with the follow-up; this slice ships only
  the list of excluded files and its disclosure.

## File Map

- CREATE `ts/src/guardian/mutation.ts`
- CREATE `ts/test/guardian-mutation.test.ts`
- MODIFY `ts/src/guardian/cli.ts` (add the `mutation` subcommand)
- MODIFY `ts/test/guardian-cli-mutation.test.ts` → CREATE
- MODIFY `.github/workflows/guardian.yml` (advisory `mutation` job)
- MODIFY `harness.config.json` (entropy + performance `entryPoints`)
- MODIFY `docs/changes/486-diff-scoped-mutation-testing/proposal.md` (A1/A2)
- MODIFY `docs/changes/486-diff-scoped-mutation-testing/provenance.json`
- MODIFY `AGENTS.md` (guardian section: the mutation job and its suppression)
- CREATE `docs/knowledge/mutation-author-obligation.md`

## Tasks

### Task 1: Mutate-entry derivation from a scoped diff

**Depends on:** none | **Files:** `ts/src/guardian/mutation.ts`,
`ts/test/guardian-mutation.test.ts`

1. Write `mutateEntries` tests: a `ChangedUnit[]` with two ranges under
   `ts/src/` yields `['ts/src/a.ts:3-5', 'ts/src/a.ts:9-9']`; a unit outside
   `ts/src/` yields nothing; an empty input yields `[]`.
2. Run `npx vitest run test/guardian-mutation.test.ts` — observe failure.
3. Implement `mutateEntries(units: ChangedUnit[]): string[]`.
4. Run the test — observe pass. Commit:
   `feat(guardian): derive stryker mutate entries from the guardian diff scope`

### Task 2: Deterministic sampling under the mutant cap

**Depends on:** Task 1 | **Files:** same

1. Tests: over the cap, `sampleMutants` keeps the first `cap` after sorting by
   (path, line, mutator id), is stable across two calls, and reports
   `sampled < generated`; at or under the cap it is identity.
2. Red, implement `sampleMutants`, green. Commit:
   `feat(guardian): cap mutants with a deterministic, disclosed sample`

### Task 3: Runner-compatibility abstain guard

**Depends on:** Task 1 | **Files:** same

1. Tests: `runnerCompatibility('10.0.0', '5.0.0')` is incompatible with a reason
   naming `stryker-js#6210`; `(null, '5.0.0')` is incompatible ("not
   installed"); `('10.1.0', '5.0.0')` and `('10.0.0', '4.9.0')` are compatible.
2. Red, implement, green. Commit:
   `feat(guardian): gate the mutation run on a runner that can kill mutants`

### Task 4: Stryker JSON report → MutationReport

**Depends on:** Tasks 2, 3 | **Files:** same

1. Tests over a fixture report literal: `Killed` → `killed`; `Survived` with a
   non-empty `coveredBy` → `survived`; `Survived` with empty `coveredBy` →
   `no-coverage`; `NoCoverage` → `no-coverage`; `Timeout` → `timeout`; counts
   and `verdict` derived; `excludedTests` carried onto the report.
2. Red, implement `mapStrykerReport`, green. Commit:
   `feat(guardian): map a stryker report to the guardian mutation report`

### Task 5: Abstention rules and the zero denominator

**Depends on:** Task 4 | **Files:** same

1. Tests: zero mutants → `abstained`; every mutant `no-coverage` → `abstained`;
   a report that abstains never carries a `survived` finding; `abstained(...)`
   carries `excludedTests`; `mutationExitCode` returns 3/1/0.
2. Red, implement `abstainedReport` and `mutationExitCode`, green. Commit:
   `feat(guardian): abstain on a zero mutation denominator rather than pass`

### Task 6: `canary:allow-mutant` suppression

**Depends on:** Task 5 | **Files:** same

1. Tests: a survivor whose source line carries
   `// canary:allow-mutant flaky equivalent` is suppressed with that reason and
   drops out of `survived`; a bare `// canary:allow-mutant` is ignored; `#`
   leader works.
2. Red, implement `mutantSuppressionReason` + `applyMutantSuppressions`, green.
   Commit: `feat(guardian): honor canary:allow-mutant suppressions`

### Task 7: Rendering with an always-visible denominator

**Depends on:** Task 6 | **Files:** same

1. Tests: an all-killed render contains `12/12`; a sampled render contains
   `sampled 150 of 400`; an abstained render contains the reason and never the
   word `survived` as a verdict; every render lists `excludedTests`.
2. Red, implement `renderMutationReport`, green. Commit:
   `feat(guardian): render the mutation report with its denominator`

### Task 8: `canary guardian mutation` subcommand

**Depends on:** Task 7 | **Files:** `ts/src/guardian/cli.ts`,
`ts/test/guardian-cli-mutation.test.ts` | **Category:** integration

1. Tests through the existing guardian CLI testkit: `--json` on a fixture report
   emits the report JSON; the default run with no Stryker installed exits 3 and
   names `stryker-js#6210`; `--report` on a survivor fixture exits 1; an
   all-killed fixture exits 0.
2. Red, implement the subcommand (thin: parse → library → emit), green. Commit:
   `feat(guardian): add the canary guardian mutation subcommand`

### Task 9: Advisory CI job, ratchets and docs

**Depends on:** Task 8 | **Files:** `.github/workflows/guardian.yml`,
`harness.config.json`, `AGENTS.md`,
`docs/knowledge/mutation-author-obligation.md` | **Category:** integration

1. Add the non-required `mutation` job to `guardian.yml`: `ubuntu-latest`,
   build, run the subcommand, treat exit 3 as a `::warning`, never fail on exit
   1, upload `mutation-report.json`.
2. Declare `ts/src/guardian/mutation.ts` in BOTH `entropy.entryPoints` and
   `performance.entryPoints` in `harness.config.json`. Never raise
   `maxFindings`.
3. Document the job, its advisory status and `// canary:allow-mutant` in
   AGENTS.md, and the author obligation (D9) in `docs/knowledge/`.
4. `cd ts && npm run build && npm run typecheck && npm run format:check && npm test`.
   Commit: `feat(ci): advisory diff-scoped mutation job (#486)`

## Risks

- **A guard that rots into a false green.** If a future runner version reports
  compatible while still filtering nothing, the check would start printing
  survivors again. Mitigated by the guard being one exported constant with its
  own test, and by the job staying advisory until the D5 evidence window runs.
- **Excluded thread-unsafe tests inflate the false-survivor rate** once the
  runner works, which is the F5 risk the spec now records as A2.
