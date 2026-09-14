# `canary analyze gh-flaky`: flake signals that survive an in-place Re-run (#884)

**Keywords:** flake-detection, github-actions, run_attempt, rerun-to-green,
same-sha-flip, abstention, gate-contract

## Overview

GitHub's _Re-run_ mutates a workflow run in place. It bumps `run_attempt` and
replaces `conclusion`, so a run that failed and was re-run to green leaves one
row that says `success`. A flake scan keyed only on same-SHA outcome flips reads
that surface and reports "0 candidates" whether flakes exist or not.

This change adds a scan that reads both signatures and says which ones its
answer was verified against.

## Decisions made

| Decision           | Choice                                                                                                          | Rationale                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement          | New subcommand `canary analyze gh-flaky`, next to `flaky` and `spikes`                                          | Human decision (#884 fleet brief). `analyze flaky` reads the test-level history store, not GitHub runs, so extending it would mix two sources. |
| Logic location     | Pure module `ts/src/analysis/gh-run-attempts.ts` behind an injected `SubprocessRun` seam                        | Same seam `batwoman/gh-history.ts` uses; tests never shell out.                                                                                |
| Rerun signature    | For each run with `attempt > 1`, read `/repos/{o}/{r}/actions/runs/{id}/attempts/{n}` for every earlier attempt | Only source that keeps the pre-rerun conclusion. Verified reachable: `gh api .../actions/runs` returns `run_attempt`.                          |
| Unreadable attempt | Window reported as `flake-signal-unverifiable`, naming the endpoint that failed                                 | #884 acceptance: never folded into a zero.                                                                                                     |
| Exit codes         | CLI-wide gate contract: 0 verified zero, 1 candidates, 3 abstained or unverifiable                              | Matches `canary ci-ready` (#914).                                                                                                              |

### Approaches considered

1. **Per-run attempts API (chosen).** Exact. Costs one `gh api` call per earlier
   attempt, and only for reruns, which are rare.
2. **Treat any `attempt > 1` as a candidate without reading attempts.** No extra
   calls, but a rerun of a _cancelled_ run or a rerun-after-success would be a
   false positive, and it cannot say what the earlier outcome was.
3. **Jobs API per attempt** (`/attempts/{n}/jobs`). Finer grain, but more calls
   and pagination for no acceptance criterion that needs it. YAGNI.

## Technical design

- `listRuns`:
  `gh run list --repo R --limit N --json databaseId,headSha,workflowName,conclusion,attempt`.
  A failing or unparseable call throws, and the scan turns that into `abstained`
  with the reason stated.
- `sameShaFlips`: group by `headSha` + `workflowName`. A group holding both a
  `success` and a non-success conclusion is a candidate.
- `rerunCandidates`: for `attempt > 1` with a current `success`, read each
  earlier attempt. Any non-success earlier conclusion is a candidate. A read
  that fails is recorded as unverifiable with the endpoint named.
- Verdict order: zero runs or a list failure gives `abstained`. Any candidate
  gives `candidates`. Otherwise, any unverifiable read gives
  `flake-signal-unverifiable`. Otherwise the result is `verified-zero`.
- Every report names `verifiedAgainst` (`same-sha-flip`, `rerun-attempt`). The
  rerun signature is listed only when every attempt read succeeded.

## Integration points

- **Entry points:** new `canary analyze gh-flaky` subcommand in
  `ts/src/analysis/cli.ts`.
- **Registrations required:** `AnalyzeDeps.runGh` seam. A gate-conformance row
  in `ts/test/gate-conformance.test.ts`. `ts/src/analysis/gh-run-attempts.ts`
  goes in both `entropy.entryPoints` and `performance.entryPoints` if the
  entropy scan flags it.
- **Documentation updates:** README command table, and the `canary-fleet-health`
  SKILL.md report table.
- **Architectural decisions:** none. This follows the existing gate contract and
  the existing gh seam.
- **Knowledge impact:** the domain fact that a GitHub Re-run is in-place, so a
  same-SHA flip scan alone is blind to reruns.

## Success criteria

- When a window contains a run with `attempt > 1` whose earlier attempt did not
  succeed, the scan reports it as a `rerun-attempt` candidate and exits 1.
- If an earlier attempt cannot be read, the scan reports
  `flake-signal-unverifiable`, names the endpoint, and exits 3. It never reports
  a zero.
- A clean window reports 0 candidates with both signatures named, and exits 0.
- An empty window or a failed `gh run list` abstains with exit 3.
- Output never contains a bare "0 candidates" without the signatures it was
  verified against.

## Implementation order

1. Failing tests for the pure module (fixtures: rerun-to-green, unreadable
   attempts, clean verified zero, same-SHA flip, abstentions).
2. Implement the module.
3. Wire the subcommand, then add the CLI exit-code tests and the conformance
   row.
4. Perf paydown, docs, and gates.
