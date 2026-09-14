# Plan: guardian coverage eligibility and PR-head diff (#883, scope a+b)

## Root cause

1. **(a) Dishonest zero-match wording.** `coverageDegradedNotice`
   (`ts/src/guardian/diff-coverage/orchestrator.ts`) and `coverageDeltaNotice`
   (`ts/src/guardian/diff-coverage/coverage-delta.ts`) collapse two opposite
   causes into one line, `covers N file(s) but matched 0 of M`. The state
   records `filesInReport` and `unitsMatched` but never how many changed files
   were even _eligible_ (inside a tree the report instruments). The path matcher
   is not at fault (ruled out in the issue): `ts/coverage/lcov.info` only
   instruments `ts/src`, so a PR touching `npm/`, `scripts/` or `agents/skills/`
   can never match, and the notice blamed the report.
2. **(b) Merge-ref diff.** `readPrDiff` (`ts/src/guardian/cli.ts`) always diffs
   `<base>...HEAD`. On a `pull_request` checkout HEAD is `refs/pull/<n>/merge`,
   so the diff is widened. `detectMergeRef` disclosed it but the widened set was
   still judged.

## Approach

- `report-tier.ts` gains `countEligible` (anchors a report's relative paths to
  the nearest ancestor of the report's directory where they exist, derives the
  instrumented trees, counts changed paths inside one) and `zeroMatchClause`
  (the shared wording). Both notices call `zeroMatchClause`; both states carry
  an optional `unitsEligible`.
- `readPrDiff` resolves the event-declared PR head (`pull_request.head.sha` from
  `GITHUB_EVENT_PATH`); when that commit exists locally it diffs
  `<base>...<head sha>` and returns `head`. `prCheckCmd` uses that head for
  provenance, so `detectMergeRef` no longer fires on a diff that is the PR's
  own. An unfetched head falls back to `HEAD` and the existing merge-ref
  warning.

## Tasks

1. Failing tests: `guardian-coverage-input-state.test.ts` (scope gap, stale,
   `npm/src` vs `ts/src` anchoring), `guardian-coverage-delta.test.ts` (eligible
   denominator in both branches), `guardian-pr-check-ci-diff.test.ts` (diff to
   PR head; fallback to HEAD). Confirmed red: 6 failing.
2. Implement eligibility + wording in existing modules (no new module).
3. Implement PR-head resolution in `readPrDiff`.
4. Gates from `ts/`: build, typecheck, format:check, test.

## Assumptions

- `.github/workflows/guardian.yml` needs no change: Actions always provides
  `GITHUB_EVENT_PATH`/`GITHUB_EVENT_NAME`, and `fetch-depth: 0` makes the head
  sha resolvable. No `GITHUB_PR_HEAD_SHA` variable was introduced.
- A report whose paths cannot be anchored (report outside the repo) is treated
  as repo-root-relative.
- `unitsEligible` is optional so producers that never compute it keep the
  previous wording.
- Out of scope, untouched: instrumenting `npm/`, `scripts/`, `agents/skills/`,
  and coverage-exempt trees (#883 part c stays open).
