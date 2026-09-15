# Diff-scoped mutation testing: prove a PR's tests can fail (#486)

**Keywords:** mutation-testing, stryker, vitest, diff-scope, surviving-mutant,
abstention, guardian, advisory-exit-criterion

> **Status: spec only.** This proposal came out of a roadmap-fleet run where a
> human said "spec only". Nobody has signed it off, and it contains no code, no
> scripts and no workflow changes. The defaults marked _assumption_ were chosen
> without asking anyone. The forks at the end still need a human decision.

## Overview

Coverage and pass counts show that tests ran. They do not show that a test would
fail if the code were wrong. In #486, three vacuous tests (`canary-katana`,
`canary-fail-fast`, `canary-savant`) passed CI against the exact bugs they were
written to catch. Across #472 the same class of problem came back three rounds
in a row, and it only stopped when someone ran mutants by hand. Over that period
the suite grew from 397 to 506 tests while the gates stayed green the whole
time.

Mutation testing makes small, deliberate breaks in the source (for example,
flipping `if (force)`) and re-runs the tests. A mutant that no test notices is
said to _survive_. Each survivor is concrete evidence of a weak assertion.
Running this over the whole suite is too slow for PR CI: 187 test files under
`ts/test` and `ts/src`. This spec therefore limits mutation to the lines a PR
adds, reusing the diff scoping the guardian already has.

### Goals

1. Mutate only the lines a PR adds in `ts/src/**`, within a fixed CI time
   budget.
2. For every surviving mutant, report the file and line, the mutation, and the
   tests that covered it but did not fail.
3. Treat zero mutants as an abstention, never as a pass (ADR 0009).
4. Start as an advisory check, with a written, measurable exit criterion for
   becoming a gate.

### Out of scope

- Mutating the whole repo, on a schedule or otherwise. That can be a later
  change if the diff-scoped run proves useful.
- Python and shell. The project is JS/TS only for new work, and #933 already
  stopped treating shell as program source.
- Automatically writing stronger assertions (the Tier-2 authoring idea from
  #339's katana plan). See Fork F2.
- `agents/skills/**/scripts/*.mjs`. The issue suggests it, but these scripts
  have no vitest coverage mapping today. Deferred; see Fork F3.

## Decisions made

| #   | Decision                 | Choice                                                                                                                                                          | Rationale                                                                                                                                                                                                      |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Tool                     | StrykerJS (`@stryker-mutator/core` plus `@stryker-mutator/vitest-runner`), pinned as a devDependency in `ts/`                                                   | The only maintained TS mutator with a vitest runner. It supports line-range scoping (`--mutate file:start-end`) and `coverageAnalysis: perTest`, which gives per-test kill attribution (Goal 2). _Assumption._ |
| D2  | Scope unit               | Line ranges added in the diff, taken from `scopeDiff()` (`ts/src/guardian/pr-check.ts:96`), then the same skip, test-file and type-only filters                 | One definition of "what this PR changed", shared with guardian coverage. No second diff parser that could drift from the first.                                                                                |
| D3  | Placement                | A new guardian subcommand (`canary guardian mutation`) run by a new, non-required job in `guardian.yml`                                                         | Reuses the diff provenance, `GuardianConfig` skip globs and sticky-comment plumbing. It is a plain CI step rather than a skill, answering #486's "skill or CI step?" for v1. _Assumption_; see Fork F1.        |
| D4  | Posture                  | Advisory. Survivors produce `::warning` annotations and a sticky section; the job always exits 0 on survivors                                                   | The issue asks for this. ADR 0009's advisory/gate split. Required checks must not be path-filtered (ADR 0011), so an advisory job stays out of the ruleset.                                                    |
| D5  | Exit criterion to gating | Promote once 20 consecutive PRs that produced mutants show a false-survivor rate ≤ 10% on human triage and p90 runtime within budget                            | #485: an advisory check with no exit criterion is an evasion. The numbers are _assumptions_ modelled on how #527 used precision evidence for the guardian hard gate.                                           |
| D6  | Abstention               | Zero mutants generated, zero mutants covered by any test, Stryker crashing or timing out, or a missing diff: report `abstained` with the reason, exit 3 locally | ADR 0009 and `isCoverageAbstention` (`pr-check.ts:1149`). "0 survived of 0" looks exactly like a pass, and that is the false green this whole issue is about.                                                  |
| D7  | Time budget              | Hard 10-minute wall-clock cap for the job; mutants capped at 150 per PR, sampled deterministically (by file, then line) when over the cap                       | Guardian already runs the whole vitest suite. The cap keeps the added cost bounded. A capped run says "sampled N of M", never "all". _Assumption._                                                             |
| D8  | Mutator set              | Stryker defaults, minus `StringLiteral` and `ObjectLiteral` in v1                                                                                               | Those two mostly produce equivalent or noisy survivors in message text and config objects. Removing them protects the false-survivor rate in D5. _Assumption._                                                 |
| D9  | Author obligation        | For each survivor the author either (a) adds or strengthens a test that kills it, or (b) adds `// canary:allow-mutant <reason>` on the line                     | Mirrors the existing `canary:allow-untested` suppression (`suppressionReason`, `pr-check.ts:868`), so reviewers already recognise the pattern. This is the "documented policy" acceptance item.                |

### Approaches considered

1. **Stryker, scoped to diff line ranges, run as a guardian subcommand
   (chosen).** It is precise (only added lines), gives per-test attribution, and
   reuses guardian scoping. The cost is a new devDependency and one instrumented
   vitest run for coverage analysis. Complexity is medium.
2. **Stryker, scoped to whole changed files, as a standalone workflow step.**
   Simpler: it passes file globs and needs no new module. But a one-line change
   to `pr-check.ts` (1,800+ lines) would mutate the entire file and blow the
   budget, and the output could not be tied to what the PR actually changed.
   Complexity is low; the risk to the budget is high.
3. **A home-grown mutator that applies a few AST flips (conditions, boundaries,
   return values) to diff lines and runs `vitest --related`.** No dependency and
   complete control. It would, however, re-implement what Stryker already does
   (rule 11, don't hand-roll existing tooling), and per-test attribution would
   have to be built from scratch. It also adds new modules to the entropy and
   perf ratchets. Complexity is high.

## Technical design

This describes the design only; nothing is built in this change.

- **Scope.** `mutation-scope.ts` turns guardian's filtered `ChangedUnit[]` into
  Stryker `mutate` entries (`path:start-end` for each added range) and keeps
  only paths under `ts/src/`.
- **Run.** Stryker is called with `testRunner: vitest`,
  `coverageAnalysis: perTest`, the `reporters: ['json']` mutation-testing report
  schema, `timeoutMS`, and `concurrency` set to the number of runner cores. The
  run happens in `ts/` after `npm run build`, so vitest resolves the same
  configuration as `npm test`.
- **Result model.** Mirrors the guardian findings shape:

  ```ts
  type MutationStatus = 'killed' | 'survived' | 'no-coverage' | 'timeout';
  interface MutantFinding {
    path: string;
    line: number;
    mutator: string; // e.g. ConditionalExpression
    replacement: string; // the mutated source snippet
    status: MutationStatus;
    coveredBy: string[]; // test full names that ran but did not fail
  }
  interface MutationReport {
    verdict: 'survivors' | 'all-killed' | 'abstained';
    abstainReason?: string;
    generated: number;
    sampled: number; // == generated unless capped (D7)
    killed: number;
    survived: number;
    noCoverage: number; // reported separately: a coverage gap, not weak assertions
    findings: MutantFinding[];
  }
  ```

- **Verdict rules.** `abstained` if `generated === 0`, or if every mutant is
  `no-coverage` (guardian coverage already reports that gap), or if Stryker
  exits non-zero or hits the cap. `survivors` if any mutant survived after
  suppressions. Otherwise `all-killed`, and the headline always shows the
  denominator: "12/12 mutants killed".
- **Output.** A `### Mutation` section in the guardian sticky comment, kept
  inside `COMMENT_CHAR_BUDGET` (`pr-check.ts:976`). Survivors come first,
  grouped by the test that should have killed them. Each survivor also gets a
  `::warning file=…,line=…` annotation, and `mutation-report.json` is uploaded
  as an artifact.
- **Exit codes (local CLI).** 0 all-killed, 1 survivors, 3 abstained, following
  ADR 0009. The CI job wraps the command and records the code in the sticky
  instead of failing the step (D4).

## Integration points

### Entry points

- New subcommand `canary guardian mutation` (`ts/src/guardian/cli.ts`).
- New job `mutation` in `.github/workflows/guardian.yml`, deliberately
  non-required.

### Registrations required

- `entropy.entryPoints` in both arrays, for any new module (memory: the entropy
  ratchet counts new modules against the ceiling).
- An architecture-layer allowance for `guardian → mutation-scope` if the layer
  model requires one, plus dead-export and perf checks on the new CLI surface.
- New devDependencies in `ts/package.json` and the lockfile.

### Documentation updates

- AGENTS.md guardian section: the mutation job, its advisory status and
  suppression syntax.
- `docs/knowledge/`: the author-obligation policy (D9).
- The `canary-pr-guardian` skill doc: a Tier-0.5 mutation pass.

### Architectural decisions

- **D5 + D6** should become ADR 0026, "Mutation findings are advisory until a
  measured exit criterion", because they commit the project to a promotion rule
  and a definition of abstention that later gates will be held to.
- **D3** (a CI step rather than a skill) only needs an ADR if Fork F1 is decided
  as "skill".

### Knowledge impact

New concepts: _surviving mutant_, _equivalent mutant_, _mutation abstention_,
and _false-survivor rate_. New relationships: guardian `scopeDiff` feeds
mutation scope; `canary:allow-mutant` is a sibling of `canary:allow-untested`.

## Success criteria

Each criterion is observable, so it can be checked from a PR or a local run.

1. **Regression case (#486 acceptance).** When the `if (force)` mutation from
   #484 is reintroduced on a branch as a diff line, and the load-bearing test is
   weakened so it no longer checks file content, the mutation job reports that
   line as `survived` and names the covering test(s). With the test restored,
   the same mutant reports `killed`.
2. **Attribution.** Every `survived` finding has a non-empty `coveredBy`. A
   survivor with empty `coveredBy` is classified as `no-coverage` instead.
3. **Budget.** Across the first 20 PRs that produce mutants, the p90 wall-clock
   time of the mutation job is ≤ 10 minutes, and no run exceeds the cap without
   reporting `sampled < generated`.
4. **Abstention.** A docs-only PR, a PR whose added lines are all type-only, and
   a run where Stryker is forced to fail each report `abstained` with a reason.
   None of them renders "0 survived" or exits 0 locally.
5. **Suppression.** A survivor on a line with `// canary:allow-mutant <reason>`
   is listed as suppressed, with the reason, and is not counted in `survived`. A
   bare marker with no reason is ignored.
6. **Advisory.** The `mutation` job never fails the PR on survivors, and it does
   not appear in `.github/required-checks.json`.
7. **Exit-criterion evidence.** `mutation-report.json` artifacts include enough
   fields (verdict, counts, findings, durations) to compute the D5
   false-survivor rate and p90 without re-running anything.

## Implementation order

1. **Spike (throwaway, not merged).** Run Stryker by hand on #484's diff to
   confirm that line-range `mutate`, the vitest runner with
   `coverageAnalysis: perTest` against `ts/vitest.config.ts`, and runtime all
   work as assumed. This checks assumptions A1 and A2.
2. **Scope and report core, TDD.** Build `mutation-scope.ts` and a pure mapper
   from Stryker's JSON report to `MutationReport`, with abstention rules and
   suppressions. Unit tests use fixture reports.
3. **CLI subcommand.** Add the command and its exit codes, and pass the three CI
   ratchets for a new CLI surface (entropy, dead exports, perf/architecture).
4. **CI job and sticky section.** Wire the advisory job into `guardian.yml` and
   add the annotations and artifact.
5. **Verification.** Run success criteria 1, 4 and 5 on real PRs. Then start the
   D5 20-PR evidence window.
6. **ADR 0026 and docs.** Write the ADR, update AGENTS.md and the knowledge
   entry.

## Assumptions

- **A1:** StrykerJS's vitest runner works with `ts/vitest.config.ts` (v8
  coverage, `src/**/*.test.ts` and `test/*.test.ts`) without changing the
  config. Checked by implementation step 1.
- **A2:** Line-range `mutate` entries cut the mutant count enough that a typical
  PR stays under 150 mutants. Checked by step 1.
- **A3:** The budget numbers (10 min, 150 mutants) and the exit criterion (20
  PRs, ≤ 10% false survivors) are starting values, to be revised in ADR 0026
  once the spike has measured them.
- **A4:** The job runs on `ubuntu-latest` only. Mutation results do not depend
  on the OS, and running it across the OS matrix would multiply the cost.
- **A5:** `scopeDiff` added-line ranges are the right unit. Pure deletions add
  no mutants by construction, and they are reported as such.

## Open forks (need a human decision)

| Fork | Question                                                        | Options                                                                                                                   | Recommended                                                                                                                                                                               |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Guardian CI step, or the `canary-katana` mutation skill (#339)? | (a) guardian subcommand plus CI job; (b) a new skill with a `cli: *.js`; (c) both, with the skill wrapping the subcommand | **(a)** now. Katana shipped as quarantine, and reusing guardian scoping avoids a second diff parser. Do (c) later if demand appears.                                                      |
| F2   | Should v1 also propose stronger assertions for survivors?       | (a) report only; (b) Tier-2 LLM suggestion at the desk                                                                    | **(a)**. YAGNI: the issue asks for actionable reports, and suggestions add an LLM dependency and their own precision problem.                                                             |
| F3   | Include `agents/skills/**/scripts/*.mjs`?                       | (a) `ts/src` only; (b) include skill scripts now                                                                          | **(a)**. Those scripts are outside the vitest coverage `include: ['src/**']`, so `coverageAnalysis: perTest` could not attribute kills and every survivor would abstain as `no-coverage`. |
| F4   | What happens when a PR goes over the mutant cap?                | (a) deterministic sample plus a "sampled" headline; (b) abstain entirely; (c) no cap, rely on the timeout                 | **(a)**. A partial result that honestly states its denominator is more useful than silence, and (c) makes the budget unpredictable.                                                       |
| F5   | Exit-criterion thresholds                                       | (a) 20 PRs / ≤ 10% false survivors; (b) 50 PRs / ≤ 5%; (c) time-boxed to 30 days, whatever the count                      | **(a)**, revised after the spike. (c) brings back the permanent-advisory drift that #485 warns about.                                                                                     |
