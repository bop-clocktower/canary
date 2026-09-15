# #928 — guardian: one honest headline per cause

Route: bug (debugging discipline + TDD). The design was decided in the issue
(2026-09-14); this plan only implements it.

## Root causes

1. **Case E (config/data counted for coverage).** The `kept` chain in
   `ts/src/guardian/cli.ts` had no source-extension floor, so `.json`/`.yml`
   units reached `resolveCoverageWithInput`, could never match lcov, and turned
   the headline ⚠️.
2. **Case A misdiagnosed as stale.** `matchUnitsToIndex` `continue`d both for an
   absent path and for a unit whose changed lines were all non-coverable, and
   `countEligible` counted every in-tree unit, so a doc-comment edit read as a
   stale report.
3. **One generic headline, notice rendered twice.**

## Tasks

1. Failing tests first (`ts/test/guardian-verdict-per-cause.test.ts`) from the
   real shapes: #927 and #841 (A), #925 (B), mixed A+B, a genuine C, #658 and
   #720 (E), plus a docs/tests-only control that must still abstain.
2. `report-tier.ts`: `matchUnitsToIndex` records non-coverable-only units in a
   caller-supplied sink; `instrumentedTrees` is exported.
3. `orchestrator.ts`: `CoverageInputState` gains `unitsNonCoverable` and
   `instrumentedTrees`; `unitsEligible` now counts only ABSENT in-tree units
   (the stale count); `coverageCauses` splits stale / scope gap / non-coverable;
   the notice is `null` when the report spoke to every unit.
4. `cli.ts`: apply the existing `isSourcePath` floor before coverage. Dropped
   units become `non-source` skip entries. A run with nothing eligible still
   abstains (exit 3, ADR 0009), and under `--post-comment` `abstainPrCheck`
   upserts the ✅ E sticky so an earlier ⚠️ one cannot linger.
5. `pr-check.ts`: `coverageHeadline` picks the worst cause (C > B > A/E), lists
   the rest as counts, and feeds both the comment and text surfaces. The comment
   footer no longer repeats the coverage notice.
6. Pay down `ts/src` non-blank lines to net ≤ 0 by trimming comments.
7. Gates from `ts/`, then arch / perf / entropy ratchets.
