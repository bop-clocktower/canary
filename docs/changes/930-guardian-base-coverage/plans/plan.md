# Plan: guardian base coverage (#930)

## Problem

`guardian.yml` never passed `--base-coverage`, so the coverage-delta tier (#881)
reported `head-only` on 24 of 24 guardian comments.

## Shape chosen

**Artifact from main.** Rejected: measuring the base in-job, which roughly
doubles the guardian test time and works against the duration ratchet
(#760/#820).

1. `harness-quality.yml` / `ts-validate` (`TS engine (pilot)`): after
   `npm test`, upload `ts/coverage/lcov.info` as
   `ts-coverage-lcov-${{ github.sha }}`. This is a step `if:` for push to `main`
   only. It adds no job and no check context, so branch protection waits on
   nothing new. `if-no-files-found: error`, retention 30 days.
2. `guardian.yml`: add `actions: read`, plus a `Resolve base coverage` step:
   - `BASE_SHA=$(git merge-base origin/$BASE HEAD)`, the same base pr-check
     diffs against.
   - List artifacts named `ts-coverage-lcov-$BASE_SHA`. Accept one only if it
     has not expired, its `workflow_run.head_sha == BASE_SHA`, and its
     `head_branch == $BASE`. That is how a stale or mismatched artifact gets
     detected. The latest main run is never substituted.
   - Download and unzip it, then check that `lcov.info` is non-empty. Output its
     path.
   - Every miss exits 0 with a `::notice` that names its cause. `BASE_COVERAGE`
     stays empty and pr-check posts its existing loud head-only notice.
3. The pr-check step passes `--base-coverage "$BASE_COVERAGE"` only when it is
   non-empty.

## Tests (written first, watched fail: 5 of 19)

`ts/test/guardian-workflow.test.ts` gains a `#930` block. It checks for
`actions: read`, the merge-base plus `head_sha` lookup, no `|| true|echo|:`, a
conditional `--base-coverage`, a head-only `::notice`, and a push-only,
SHA-keyed upload with `if-no-files-found: error`.

## Verification

Check the real PR. Its merge base predates the upload step, so the expected
result is the head-only notice with a green job. The first PR opened after this
merges should show a non-`unavailable` `coverage_delta`.
