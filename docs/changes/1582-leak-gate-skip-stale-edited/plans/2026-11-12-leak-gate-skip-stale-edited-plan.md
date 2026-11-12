# Plan: leak gate skips stale `edited` events and still reports the required check

Item: bop-clocktower/canary#1582 (cicd-fleet run fc1112, cause `infra-config`) ·
Pipeline: `harness:cicd-fleet` → `harness-workflow-audit` → TDD · Date:
2026-11-12 · Base: `origin/main` @ `f94dbec5`

## Root cause

`.github/workflows/leak-gate.yml` runs on `pull_request_target` with
`types: [opened, synchronize, reopened, edited]`. `edited` is there so that a
retarget re-runs the gate, but GitHub also sends it for title and body edits,
including edits to PRs that have already merged or closed. The job then fetched
that PR's old head and scanned it against the current denylist. If the denylist
had grown since, the run went red on a PR nobody can change.

## Audit (harness-workflow-audit, scoped to leak-gate.yml)

| Check                 | Result                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 path filters       | None, on purpose (#542: a required check behind a filter never reports). Clean.                                                                        |
| M2 permissions        | `contents: read` only. Clean.                                                                                                                          |
| M3 pinning            | First-party `actions/checkout@v7`, `actions/setup-node@v7` only. Clean.                                                                                |
| M4 self-trigger       | No push-back. Clean.                                                                                                                                   |
| M5 secrets            | Secret reaches the scan step via `env:` only. Clean.                                                                                                   |
| J1 injection          | Event values go via `env:`; no head checkout under `pull_request_target`. Clean.                                                                       |
| **Trigger semantics** | **WARNING:** `edited` fires on non-code edits and closed PRs, so it scans a stale head and can produce red runs that nobody can act on. This is #1582. |

## Fix (human decision: option a)

- A new first step, `decide` (id `decide`), reads `github.event_name`,
  `github.event.action`, `github.event.pull_request.state` and
  `github.event.changes.base.ref.from` through `env:` only. It writes
  `skip=true` when the event is `pull_request_target`/`edited` and either the PR
  is not `open`, or `changes.base.ref.from` is empty (no retarget). Every other
  event gets `skip=false`. A skip logs a `::notice::` so a green run says why it
  scanned nothing.
- The fetch-head and scan steps take
  `if: ... steps.decide.outputs.skip != 'true'`. Base checkout and setup-node
  still run.
- There is NO job-level `if:`. A skipped job reports `skipped`, not `success`,
  and this job is the only producer of the required context
  `No removed-symbol or proprietary leaks`. Gating at step level means the job
  still finishes green, so the context is always reported.

## Assumptions

1. `github.event.changes.base.ref.from` is set exactly when an `edited` event
   changed the base (GitHub webhook docs, `pull_request.edited` `changes.base`).
   A missing property renders as an empty string in `env:`.
2. Closed or merged PRs need no scan on `edited`. Their merge already passed the
   gate, and `push` to `main` re-scans after the merge.
3. `pull_request_target` uses the workflow from the base branch, so this change
   cannot take effect on its own PR. Its own leak-gate run uses main's version
   of the file.
4. actionlint is not installed locally (no binary, no Docker daemon). The
   `workflow-lint.yml` actionlint job checks the edited file in CI.

## Tests (written first, red: 9 failed / 1 passed before the fix)

`ts/test/leak-gate-stale-edited.test.ts` runs the decide step's own script under
bash with stub events:

1. An `edited` event on a closed PR, with or without a base change, gives
   `skip=true`, exits 0 and logs the reason. The fetch and scan steps are gated,
   so the job passes.
2. An `edited` event on an open PR with no base change gives `skip=true`.
3. An `edited` event on an open PR with a base change gives `skip=false`, so it
   still scans.
4. `opened`, `synchronize`, `reopened` and `push` give `skip=false`.
5. The decide step's `env:` is exactly the four event expressions. Its `run:`
   has no `${{ }}` and no secret.

The test also checks that there is no job-level `if:`, that the decide step runs
first with no `if:` and no `continue-on-error`, and that only the fetch and scan
steps are gated. `ts/test/leak-gate-workflow.test.ts`, which holds the safety
invariants, is unchanged and still green.
