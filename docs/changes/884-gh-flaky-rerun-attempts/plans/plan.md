# Plan: `canary analyze gh-flaky` (#884)

Spec: `docs/changes/884-gh-flaky-rerun-attempts/proposal.md`

## Constraints

- **Perf ratchet (merge-base identity delta):** measured at 224 findings on
  `origin/main` 9edae90c under harness CLI 12.7.0. The new module must add no
  finding: each function stays at cyclomatic complexity 10 or less, 50 lines or
  less, and nesting depth 4 or less, and the file stays at 300 lines or less.
  Paydown in the same PR is the `for` loop in `commonFailuresCmd`
  (`ts/src/analysis/cli.ts`, cyclomatic complexity 13). It is extracted into a
  helper at 10 or less. It decides no gate verdict, and it is not one of
  #904-#907.
- **Dead exports:** every new export has a non-test importer
  (`analysis/cli.ts`).
- **Entropy:** re-measure. Declare the module in both `entryPoints` arrays only
  if the scan flags it. Never raise `maxFindings`.
- **Arch:** `analysis` already imports `core/workflow-discovery` (batwoman). Run
  `harness check-deps` from the repo root.

## Tasks

1. **RED:** `ts/test/gh-run-attempts.test.ts`. Fixtures cover:
   - a rerun-to-green window (a candidate, exit 1)
   - an unreadable-attempts window (unverifiable, endpoint named, exit 3)
   - a clean verified zero (both signatures named, exit 0)
   - a same-SHA flip (a candidate)
   - an empty window and a `gh run list` failure (abstained, exit 3)

   Run the tests and confirm they fail.

2. **GREEN:** `ts/src/analysis/gh-run-attempts.ts`, which provides
   `scanGhFlaky`, `renderGhFlaky` and `ghFlakyExitCode`.
3. **RED to GREEN:** add CLI tests through `createAnalyzeCommand({ runGh })`
   (`--json`, exit codes, `--repo` required). Wire `gh-flaky` into
   `analysis/cli.ts`.
4. Add the gate-conformance row: an empty window abstains with exit 3 and never
   prints "0 candidates".
5. **Paydown:** pin `common-failures` row building with a test first, then
   extract the helper.
6. Docs: the README command table and the `canary-fleet-health` SKILL.md.
7. Gates from `ts/`: build, typecheck, format:check, test. Then run
   `harness check-perf` plus `scripts/perf-ratchet.mjs --base-report`, the
   entropy scan and ratchet, and `harness check-deps`.
8. Write the provenance file, commit, push, and open the PR (`Closes #884`).
9. **Review fix (PR #920), RED to GREEN:** when `gh run list` returns exactly
   `--limit-runs` rows, the report carries `complete: false`. Both the text and
   `--json` output name the cutoff ("window truncated at N runs; older runs
   unchecked"). With fewer rows, `complete` is `true`.

## Assumptions

- **The window is the last `--limit-runs` runs** (default 100) across all
  workflows.
- **A page that fills to the limit is truncated.** Following batwoman's
  `RunHistory.complete` rule, it is disclosed as `complete: false`, never
  presented as a whole answer. Truncation is measured against the raw rows gh
  returned, not the rows that parsed.
- **Malformed rows are disclosed.** A gh row without a numeric `databaseId` and
  a string `headSha` is skipped. It is counted as `skippedRows` and named in the
  text output, the same way truncation is, so the checked-run count can never
  quietly shrink.
- **Truncation is disclosure, not an abstention.** The verdict and exit code
  still cover the declared window, so a zero over a truncated window stays
  `verified-zero` (exit 0) with the cutoff named next to it.
- **Only green reruns are inspected.** A rerun whose current conclusion is not
  `success` is a visible failure, so it is not checked as a hidden flake.
- **No attempt number, no rerun verification.** A row with no numeric `attempt`
  is never defaulted to 1. Such rows are counted as `missingAttemptRows`,
  `rerun-attempt` is dropped from `verifiedAgainst`, and a window with no
  candidates becomes `flake-signal-unverifiable` (exit 3). The output says "N
  run row(s) carried no attempt number; rerun-attempt not verified".
- **Only completed outcomes can flip.** A conclusion of `""` (in progress),
  null, `skipped`, `neutral`, `action_required` or `stale` is not an outcome.
  Such runs, and earlier attempts that ended that way, are never a flip partner
  or a rerun candidate. They are counted as `nonOutcomeRows` and disclosed.
  `failure`, `cancelled`, `timed_out` and `startup_failure` are failure-class.
