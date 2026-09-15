# Plan: guardian adjudication without reactions (#938, ADR 0025)

Route: spec-ready. The spec is
`docs/knowledge/decisions/0025-adjudication-without-reactions.md` (accepted).
Every design fork is decided there; this plan only orders the build.

## Tasks

1. Red tests in `ts/test/guardian-adjudication.test.ts` (rewritten):
   - `fp:` parsing: plain reason intentional; `fp:` false positive; case and
     whitespace; a bare `fp:`; `fp` inside a word is not the prefix
   - suppressions read from ADDED diff lines only; `fp:` wins on a tie
   - sticky parsing from `renderFindings`' own output; no-gaps body is zero
     findings; a non-sticky body and a table with no parseable row are `null`
   - classification: TP, intentional, FP, unresolved, ambiguous (file left the
     diff), ambiguous (heuristic tier)
   - report: below 30 is `null` and renders `unknown (N < 30)`; at 30 renders a
     percentage with `n=`; intentional/ambiguous/unresolved never count toward
     the floor; missing edit history and an unparseable sticky are counted in a
     disclosed denominator
   - CLI: `precision` below the floor, `--json` null, no token exits 2,
     `collect-adjudications` is gone
2. Red tests in `ts/test/guardian-github-paging.test.ts` for the GitHub seam:
   sticky found past page 1 by the author-aware `findSticky` (#931), a human
   comment carrying the marker is ignored, merged-PR window bound refuses rather
   than truncates, revisions from `userContentEdits` (never-edited, truncated,
   redacted).
3. Implement pure logic in `ts/src/guardian/adjudication.ts` (replacing the
   reaction code) and the GitHub seam in
   `ts/src/guardian/adjudication-github.ts` (`AdjudicationSource`,
   `GitHubAdjudicationSource`, `FakeAdjudicationSource`, `collectEvidence`).
   Reuse `suppressionReason` from `pr-check.ts` (exported) instead of a second
   suppression regex.
4. After #936 merged: in `cli.ts` remove `collect-adjudications`,
   `collectAdjudicationsBestEffort` and the reactions client dep; re-point
   `precision` at the derived report; `harden-gate` points at `precision`.
5. Weekly advisory workflow `.github/workflows/guardian-precision.yml`
   (`schedule` + `workflow_dispatch`, no `pull_request`, so no PR check and no
   `required-checks.json` entry) writing the report to the step summary.
6. CHANGELOG `[Unreleased]`: BREAKING removal, and the changed `precision`.
   Update `docs/guides/pr-guardian.md`.
7. Gates from `ts/`: build, typecheck, format:check, test. Ratchets:
   `check-arch` (module-size net <= 0), `check-perf`, entropy, dead exports.
8. Push, dispatch the workflow on the branch, record the run URL.

## Assumptions

- Granularity is per file row, because the sticky renders one row per file or
  unit and the merged diff's suppressions are located per file.
- "Lines become covered" is read as: a `coverage-verified` finding on the first
  revision is absent from the last revision while its file is still in the
  merged PR's file list. Heuristic or graph tier findings that disappear are
  ambiguous (ADR assumption).
- A bare `fp:` counts as a false positive: the prefix is the verdict.
- A never-edited sticky (`totalCount = 0`) has one revision, so its findings are
  unresolved. A history with fewer nodes than `totalCount`, or a null `diff`, is
  "no edit history" and counted.
- Window: `--days 14` by default, at most 300 merged PRs (search paged 100 at a
  time); a larger window throws instead of truncating.
- `precision` survives as the report command; only reaction collection is
  removed.
