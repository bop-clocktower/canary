# Plan: guardian coverage-delta (regression on touched units)

**Date:** 2026-09-13 | **Issue:** #606 | **Route:** `feature` | **Branch:**
`feat/606-guardian-coverage-delta`, worktree
`/Users/bs/Github/canary-606-coverage-delta`, based on `origin/main` at
`326bd2ce`.

## Problem

Guardian's Tier-0 diff-coverage answers one question: _is this changed unit
covered at all?_ It cannot see the case that actually ships regressions — a file
that was 95% covered on `main` and is 60% covered on the PR head. Every line of
that file is still "covered", so the ladder reports nothing and the gate stays
green. #606 asks for the second question: _did coverage go **down** on a unit
this PR touches, versus base?_

## Seam correction (finding)

The issue says to "reuse the existing `agent/guardian/delta_emitter.py` seam".
That path is **retired** (the `agent/` Python tree was ported to `ts/`), and its
live descendant — `ts/src/guardian/delta-emitter.ts` — turns out to be about
something else entirely: it serializes the **api-delta.json** contract
(added/removed/changed HTTP endpoints) for library-stub regeneration. It has no
coverage concept at all. The correct seam is the diff-coverage ladder:

```text
ts/src/guardian/diff-coverage/
  types.ts         leaf primitives (FileCoverage, matchFile, expandRanges)
  report-tier.ts   readReportIndex() -> ReportIndex     <- reused as-is
  orchestrator.ts  resolveCoverageWithInput() + CoverageInputState
  coverage-delta.ts  <- NEW: base-vs-head ratio comparison  (this change)
ts/src/guardian/pr-check.ts   GuardianFinding construction, GateMeta, renderers
ts/src/guardian/cli.ts        pr-check wiring, --base-coverage flag, notices
```

The design mirrors `CoverageInputState` / `coverageStatus` /
`coverageDegradedNotice` (#554) one-for-one, because the abstention problem is
identical: a delta that was never computed must not read as a delta that came
back clean.

## Architecture

```text
 units (touched files)
        |
        v
 +--------------------------+     base report (--base-coverage)
 | resolveCoverageDelta()   | <---- readReportIndex()
 |  diff-coverage/          |     head report (--coverage)
 |  coverage-delta.ts       | <---- readReportIndex()
 +--------------------------+
        |                  \
        v                   v
  UnitCoverageDelta[]   CoverageDeltaState  -> coverageDeltaStatus()
        |                                   -> coverageDeltaNotice()  (LOUD)
        v                                          |
 buildRegressionFindings()  (pr-check.ts)          v
        |                               ::warning:: + step summary
        v                                  + GateMeta.coverageDelta
  GuardianFinding kind='coverage-regression'
```

**Layering:** `coverage-delta.ts` is a leaf of the diff-coverage package — it
imports only `types.js` and `report-tier.js`, never `pr-check.ts`. Finding
construction lives in `pr-check.ts`, which already owns `GuardianFinding`, so no
new inward edge is created.

## The regression rule

Per touched file, from each report's `FileCoverage`:

- `coverable` = the lines the report says it instrumented (lcov/Cobertura are
  self-describing; coverage-json falls back to its recorded lines).
- `covered` = of those, the lines with `hits > 0`.
- `ratio = covered / coverable`, undefined when `coverable === 0`.

A **regression** is `headRatio < baseRatio` beyond a tolerance of one tenth of a
percentage point (float noise guard). The trigger is the whole-file ratio, not
per-line identity: line numbers shift under a diff, so a base line N and a head
line N are not the same line, and a line-identity rule would invent findings.
The ratios and the raw counts are both carried as evidence, so a reviewer can
see the shape of the drop (`92.0% (23/25) -> 71.4% (25/35)`).

**Severity** (a regression is graded by how far it fell, never CRITICAL — see
Assumptions):

| Drop in percentage points | Severity |
| ------------------------- | -------- |
| >= 20.0                   | HIGH     |
| >= 5.0                    | MEDIUM   |
| > 0                       | LOW      |

## The abstention (pre-answered by the issue)

Most CI never uploads a base-branch coverage artifact. When the base report is
missing, unreadable, unparseable, or speaks to none of the touched units, the
run **degrades to head-only and says so loudly**. It never silently passes.

`CoverageDeltaState` records the denominator, not a verdict:

| field               | meaning                                    |
| ------------------- | ------------------------------------------ |
| `baseRequested`     | the `--base-coverage` path, or `null`      |
| `baseFound`         | a file exists there                        |
| `baseParsed`        | it parsed into >= 1 usable record          |
| `filesInBaseReport` | files the base report carries coverage for |
| `unitsCompared`     | touched units **both** reports spoke to    |
| `unitsTotal`        | touched units submitted                    |

`coverageDeltaStatus()` -> `compared` (all units compared) | `partial` (some) |
`unavailable` (none). **Zero compared is never `compared`** — a zero denominator
is an abstention, matching ADR 0010 and the #554/#761 precedent.

`coverageDeltaNotice()` renders the loud line, e.g.

```text
coverage delta unavailable - head-only: no base coverage report was supplied;
3 changed file(s) were judged against the head report only, so a coverage
REGRESSION on them cannot be detected by this run
```

It is emitted through the same path the coverage notice already uses:
`::warning::` annotation on stdout (stderr under `--format json`, which owns
stdout) **plus** `$GITHUB_STEP_SUMMARY`.

## Task list (TDD — test first for every task)

1. **T1** `ts/test/guardian-coverage-delta.test.ts` — failing tests for
   `resolveCoverageDelta` / `coverageDeltaStatus` / `coverageDeltaNotice`:
   regression detected; improvement and flat not flagged; `coverable === 0`
   never compared; no base path -> `unavailable` + notice; base file missing ->
   `unavailable` + notice naming the path; base present but matching no unit ->
   `unavailable` (not `compared`); one of two matched -> `partial`; zero units
   -> no notice (no claim made in either direction).
2. **T2** implement `ts/src/guardian/diff-coverage/coverage-delta.ts`.
3. **T3** re-export the public names from `ts/src/guardian/coverage.ts` (the
   seam-free public face of the package).
4. **T4** failing tests for `buildRegressionFindings` in
   `ts/test/guardian-pr-check.test.ts` (severity bands; evidence string; kind).
5. **T5** implement `buildRegressionFindings` + the optional
   `GateMeta.coverageDelta` field and its `coverage_delta` json block.
6. **T6** failing CLI test: `pr-check --base-coverage` emits the notice when the
   base artifact is absent, and emits a `coverage-regression` finding when it is
   present and coverage fell.
7. **T7** wire `--base-coverage <path>` into `pr-check` in `cli.ts`.
8. **T8** four gates from `ts/` (`build`, `typecheck`, `format:check`, `test`),
   entropy/arch ratchets, `prettier --write`, provenance, PR.

## Out of scope

- Changing the analysis-record schema (stays 1.1). The delta reaches machine
  consumers through the `--format json` surface; extending the archived analysis
  record is a separate, schema-versioned change.
- Making a regression _block_ by its own rule. Regressions are graded findings
  and the **configured gate** decides, exactly like every other guardian
  finding.
- `author-plan` and `analyze`: the delta is a PR-time question and is wired to
  `pr-check` only.

## Risks

- **False regressions from a stale base artifact.** The state records
  `baseRequested` so a reviewer can see which artifact was compared; guardian
  cannot verify the artifact's provenance and does not claim to.
- **Mixed report formats** (base lcov vs head coverage-json) produce ratios from
  different coverable sets. Mitigated by carrying raw counts in the evidence
  rather than the ratio alone.
