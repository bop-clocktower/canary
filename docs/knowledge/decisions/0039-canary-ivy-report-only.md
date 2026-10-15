---
number: 0039
title: canary-ivy reports suite overgrowth and never recommends deleting a test
date: 2026-10-15
status: accepted
tier: small
source: https://github.com/bop-clocktower/canary/issues/615
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0039 — canary-ivy reports overgrowth, never deletion

**Status:** accepted **Date:** 2026-10-15 **Deciders:** Bri Stevenski
(maintainer) **Related:** #615 (canary-ivy); ADR 0021 (direction-of-fit rule);
ADR 0009 (exit 3 reserved for "abstained"); ADR 0013 and ADR 0030 (run-history
store); ADR 0029 (repo-relative `test_file` join key);
`docs/ideation/bop-themed-canary-skills-2026-07-21.md` (candidate 10)

## Context

`canary-ivy` (#615) entered the backlog from ideation as "suite overgrowth and
pruning". It would detect metastasized suites through three signals: duplicated
fixtures, tests that cover nothing other tests do not already cover, and runtime
creep over time. The ideation record scored it 2.00 and left its strongest
objection unanswered. It flagged that objection as severe enough to reshape the
premise before any spec (`docs/ideation/bop-themed-canary-skills-2026-07-21.md`,
candidate 10 and the summary note on it).

The objection is that recommending test deletion is the most dangerous advice a
test tool can give. A test that is "redundant by coverage" may be the only one
asserting the behaviour that later breaks, because line coverage records which
lines ran and not what was checked. That runs directly against canary's target
problem. `STRATEGY.md` ("Target problem") holds that line coverage can be maxed
out by assertion-free tests and is uncorrelated with whether a regression would
be caught. A pruning tool built on coverage overlap would turn that defect into
advice to delete tests.

The three signals themselves are still worth having. A suite whose runtime grows
every month, or whose fixtures are copied into a dozen files, is a real cost and
is hard to see from inside one PR. The danger is the step from a signal to a
verdict about which test can go.

Two existing surfaces sit next to this scope:

- `canary-ci-ready` scores suite runtime as one of five readiness dimensions. It
  reads the run-history store, takes the p95 of run durations over the last 30
  runs and grades it pass/warn/fail against a baseline or an absolute threshold.
  In MCP mode it also records the run back with `update_perf_baselines`
  (`agents/skills/claude-code/canary-ci-ready/SKILL.md`, "5. Suite runtime").
- The `canary-test-reviewer` agent behind `/canary-review-test` reviews test
  code one file at a time. Its dimensions include setup and teardown ("Manual
  cleanup that should be a fixture. Fixture scope too broad or too narrow") and
  assertion meaningfulness (`agents/canary-test-reviewer.md`, "Review
  dimensions" 3 and 5).

The run-history store already records `duration_ms` per run and per test
(`ts/src/history/schema.ts`, the run and test record shapes), keyed by the
repo-relative `test_file` (ADR 0029), behind one async contract (ADR 0013), with
additive schema evolution (ADR 0030). That makes it the natural source for
runtime creep over time.

`canary-ivy` is `reserved` in `docs/naming-registry.md` against #615.

At CONFIRM the maintainer chose to reshape the skill to report-only and keep the
name. That fork is settled. The rejected alternatives are listed below.

## Decision

**1. `canary-ivy` is a report-only skill for suite overgrowth.** It reports
three things and nothing else:

- **Duplicated fixtures:** the same setup defined in more than one place across
  the suite, with every location.
- **Overlapping coverage:** sets of tests whose covered lines coincide, with the
  shared lines named.
- **Runtime creep over history:** per-test and per-file duration trends read
  from the run-history store, showing where suite time went and when it grew.

It keeps the name `canary-ivy` for this reshaped scope.

**2. The hard boundary is an invariant: canary-ivy reports and never recommends
deletion.** The spec, and the tests that ship with it, are held to all of the
following:

- No output surface carries a recommendation to delete, remove, prune, drop,
  skip, quarantine or merge-away a test. That covers Markdown, JSON, CLI text
  and exit messages. A finding names what overlaps or what grew. It does not
  name what should go.
- No output ranks or scores tests by removability. There is no `removable`,
  `safe_to_delete`, `redundant` or prune-score field, and no ordering whose
  stated meaning is "least needed first".
- Every overlapping-coverage finding states, in the finding itself, that shared
  line coverage does not establish that the tests assert the same behaviour. The
  reader is pointed at the assertions, not at a delete button.
- The skill is not a gate. Findings never produce exit 1. When it has no input
  to read (no coverage data, no history), it abstains with exit 3 (ADR 0009)
  rather than reporting a clean suite.
- The spec carries a test that plants two tests with identical line coverage and
  different assertions. It asserts that the overlap is reported and that the
  output, scanned against a deletion-vocabulary denylist, recommends neither
  test for removal.

A human may still decide to delete a test after reading the report. That
decision, and its evidence, belong to the human.

**3. Boundary against existing skills.** The spec must avoid these overlaps:

- **Against `canary-ci-ready`:** ivy issues no readiness verdict and no
  pass/warn/fail runtime grade. It does not re-score the p95 that ci-ready
  already scores. It never writes perf baselines (`update_perf_baselines` stays
  ci-ready's). ci-ready answers "is this suite's runtime acceptable now". Ivy
  answers "where did the time go, and when did it grow", attributed to tests and
  files over history. Both read the same store and neither forks it.
- **Against `canary-test-reviewer` / `/canary-review-test`:** ivy does not grade
  individual tests. It makes no assertion, selector, timing or readability
  findings. The reviewer judges whether one file's fixture scope is right. Ivy
  reports that the same fixture exists in N files, which is a suite-level fact
  that a per-file review cannot see.

**4. Direction of fit (ADR 0021).** ADR 0021 says a capability earns a name and
a name does not earn a capability. Keeping `canary-ivy` respects that rule, with
one tension stated plainly.

- **Why it respects the rule.** The reshaped scope is a strict subset of the
  premise #615 was filed with. The three signals are kept and only the pruning
  verdict is removed. Nothing was invented to give the name work, and the scope
  does not overlap an existing skill once the boundary in point 3 holds. That is
  the opposite of `canary-huntress`, where two scope attempts searched for work
  and both landed on something that already existed.
- **The tension.** The ideation that produced #615 was a themed naming exercise
  (`bop-themed-canary-skills`), so the name and the premise arrived together.
  This scope cannot claim it existed first and was named later. The protection
  is the boundary itself. If brainstorming finds that, after point 3, the only
  thing left is a flag on `canary-ci-ready`, that finding is a new decision that
  supersedes this ADR. It is not a quiet fold made inside the spec.

**5. The next step is a spec through `harness:brainstorming`, not code.** The
spec must carry the invariant in point 2 as acceptance criteria.

## Consequences

- #615's premise is reshaped. "Pruning" leaves the scope and the issue's open
  concern is answered by an invariant, not by a caveat in documentation.
- The spec has a fixed acceptance criterion it cannot negotiate away: the
  planted identical-coverage test and the deletion-vocabulary scan. A later
  change that adds a "safe to remove" hint has to supersede this ADR first.
- Ivy reads the run-history store and adds no schema. If per-test trend
  reporting needs a field the store lacks, that change follows ADR 0030's
  additive rule and is decided in the spec, not here.
- The overlapping-coverage signal needs per-test coverage data, which the
  repository has not been shown to produce yet. The spec must name its source,
  or ship that signal as an abstaining "not assessed" row until a source exists.
  It must not drop the signal silently.
- There is one more surface reading the history store. A schema change there now
  has three consumers to check (ci-ready, rewind and ivy), not two.
- **Follow-up, not done here:** `docs/naming-registry.md` keeps `canary-ivy` at
  `reserved` (line 94). The status moves to `used` only when the skill ships, in
  the PR that ships it. This ADR does not touch the registry, #615, its labels
  or the roadmap.

### Assumptions made

- Report-only means no exit 1 for findings. Abstention uses exit 3 per ADR 0009.
  The brief said "report, never recommend deletion" and did not address exit
  codes, so this default keeps ivy out of the gate set.
- "Merge these tests", "skip" and "quarantine" count as deletion recommendations
  for the invariant, because each one removes a test's assertions from the run.
- The run-history store (`ts/src/history`) is the runtime-creep source. No
  separate perf store was considered.
- The source of per-test coverage data is left to the spec. It is not assumed to
  exist.
- `canary-rewind` was named as a history consumer from
  `agents/skills/claude-code/canary-rewind/SKILL.md`. Its exact reads were not
  traced for this ADR.

## Alternatives Considered

- **(b) Drop the skill and return `canary-ivy` to the pool.** Applies ADR 0021's
  precedent most strictly. Rejected because, unlike `canary-huntress`, the
  residual capability does not overlap an existing skill. Cross-file fixture
  duplication and per-test runtime trend are visible nowhere in canary today.
  Dropping the skill would lose the signals in order to avoid a verdict that the
  invariant already forbids.
- **(c) Fold the scope into an existing skill as a mode.** Runtime creep would
  go into `canary-ci-ready` and fixture duplication into the test reviewer.
  Rejected because it splits one suite-level question across two tools with
  different grains: a readiness grade and a per-file review. It would also push
  trend-over-history output into a skill whose contract is a verdict.
- **Keep the original pruning premise with a confidence caveat.** Rejected
  without a fork. A caveat on a deletion recommendation is still a deletion
  recommendation, and the ideation record already marked the objection
  unanswered.
