---
number: 0024
title:
  'Guardian coverage scope for non-ts trees: instrument npm/, exempt scripts/
  and agents/skills/'
date: 2026-09-14
status: accepted
tier: medium
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0024 — Guardian coverage scope for non-ts trees

**Status:** accepted **Date:** 2026-09-14 **Deciders:** Bri Stevenski
(maintainer) **Related:** #883 (source issue, part c); PR #917 (parts a and b:
eligible-denominator wording, PR-head diff); #508 (no silent abstention); #760
(test-duration ratchet, shipped in #820)

## Context

The guardian's tier-0 coverage verdict abstains on nearly every PR. The only
report CI produces is `ts/coverage/lcov.info` (`npm --prefix ts test` in the
coverage job of `.github/workflows/guardian.yml`), and it only instruments
`ts/src`. The repo ships source in three more trees that no report covers:

- `npm/` — the published TypeScript package. Its tests run under `node --test`
  (`npm/package.json`) and emit no lcov.
- `scripts/` (including `scripts/lib/*.mjs`) — repo tooling.
- `agents/skills/` — skill scripts shipped to consumers.

A change confined to those trees can never match the report, so the verdict
abstains. PR #917 makes that abstention honest (it now says how many changed
files were eligible), but an honest abstention that fires on most PRs still
means the coverage tier protects almost nothing outside `ts/`.

How guardian reads config today: `loadGuardianConfig`
(`ts/src/guardian/pr-check.ts`) reads the `canary.guardian` block of
`harness.config.json`. It already knows `skipGlobs` (drops a path from the gate
at every tier), `heuristicExclude` (suppresses only the heuristic tier) and a
scaffolded `coverage_paths` field. There is no concept for "this tree is known
to have no coverage instrumentation". The `--coverage` CLI flag takes one path.

Options weighed (PROPOSE):

| Option                        | Coverage verdicts  | CI cost                                                                                                     | Honesty                                                                      |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A. Instrument all three trees | Highest            | Highest: `scripts/` and `agents/skills/` tests would first have to emit lcov, some have no runner that does | Full                                                                         |
| B. Exempt all three trees     | None outside `ts/` | None                                                                                                        | Disclosed, but `npm/` is shipped code and would never get a measured verdict |
| C. Hybrid (chosen)            | `ts/` + `npm/`     | One extra coverage run (`npm/`)                                                                             | Exempt trees are skipped and counted                                         |

## Decision

Adopt option C, the hybrid.

1. **Instrument `npm/` now.** The guardian coverage job gains a second run that
   makes the `npm/` tests emit lcov (for example
   `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=npm/coverage/lcov.info`),
   next to the existing `npm --prefix ts test`. The "Verify the coverage report
   exists" step checks both files, so a missing `npm/` report fails loudly
   rather than degrading to the heuristic tier.
2. **Guardian merges more than one lcov report.** `pr-check` accepts several
   coverage reports (a repeatable `--coverage`, or the existing `coverage_paths`
   config field) and matches each changed file against the union. Each report's
   paths are anchored to its own tree, the same anchoring PR #917 introduces for
   the eligibility count. When two reports claim the same file, the result is
   the union of covered lines, never last-writer-wins.
3. **Record `scripts/` and `agents/skills/` as coverage-exempt.** The list lives
   in `harness.config.json` under `canary.guardian.coverageExempt`, a glob array
   read by `loadGuardianConfig` beside `skipGlobs` and `heuristicExclude`. It is
   a separate key on purpose: `skipGlobs` removes a path from the gate entirely,
   whereas an exempt path is still reviewed at the graph and heuristic tiers. It
   is only removed from the coverage-tier denominator. Each entry should carry a
   reason (for example
   `{ "glob": "scripts/**", "reason": "node --test without lcov; #883" }`), so
   the exemption states why it exists.
4. **A skip is disclosed, never a silent pass (#508).** When changed files match
   `coverageExempt`, the guardian comment and the analysis output show the count
   and the globs, for example
   `coverage: 3 of 5 changed file(s) judged; 2 skipped as coverage-exempt (scripts/**)`.
   A PR whose changed files are all exempt reports a skip with its count, which
   is a different outcome from the zero-match abstention (exit 3) that PR #917
   words. It is not reported as a coverage pass.
5. **Exemptions are temporary per tree.** Each exempt tree is instrumented, and
   its entry deleted, once its tests can emit lcov. The exemption is a recorded
   gap, not a permanent carve-out.

This ADR records the decision only. The instrumentation, the multi-report merge
and the `coverageExempt` key are follow-up implementation work.

## Consequences

### Positive

- PRs touching `npm/` get a measured coverage verdict instead of an abstention.
- PRs touching only `scripts/` or `agents/skills/` stop reading as a gate that
  silently failed. They show a counted, named skip.
- The exemption list is one reviewable place that states which trees are
  unprotected at the coverage tier, and why.

### Negative / costs

- **CI duration.** The `npm/` coverage run adds wall-clock time to the guardian
  job, and coverage instrumentation slows the `npm/` tests themselves. The
  test-duration ratchet from #760 (shipped in #820) will see that, so the
  implementing PR has to measure the before and after and account for it in the
  ratchet deliberately. It must not raise a ceiling quietly. The run belongs in
  the guardian coverage job (where `ts/coverage/lcov.info` is produced today),
  not in a new job, so a single job owns every report the guardian reads.
- **Merge complexity.** Guardian must merge several lcov reports with different
  path roots. That is new code in the coverage-verified scorer, and a defect
  there reaches consumers (see #655). It needs its own tests, including
  overlapping-file and mismatched-root cases.
- **Exemption rot.** An exempt tree can stay exempt forever. The disclosure
  keeps it visible on every PR that touches it, which is the counter-pressure.
  Nothing mechanically forces instrumentation.
- **Config surface.** A new `coverageExempt` key has to be documented next to
  `skipGlobs` and `heuristicExclude`, and the difference between the three
  explained, or it will be confused with `skipGlobs`.

### Assumptions made

- `node --test` on the repo's pinned Node (>=22) can write lcov for `npm/`
  through its built-in coverage reporter. If it cannot for this package, the
  fallback is `c8`, which is an implementation detail, not a change to this
  decision.
- `harness.config.json` `canary.guardian` stays the guardian's config source. No
  separate `.canary/` file is introduced for this.
- A skip outcome for an all-exempt PR does not need a new exit code. It is
  reported in the comment and the analysis. Whether it should map to exit 0 or
  exit 3 (ADR 0009) is left to the implementation PR, provided the comment never
  reads as a coverage pass.
- PR #917 lands first. Its eligible-count anchoring is reused for multi-report
  matching.
