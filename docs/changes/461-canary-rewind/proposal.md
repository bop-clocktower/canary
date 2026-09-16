# canary-rewind: reconstruct and replay a past test run (#461)

**Keywords:** run-history, replay, reproducibility, seed, test-order,
environment-fingerprint, abstention, nearest-green, flakiness-handoff

> **Status: signed off 2026-09-16.** A human reviewed this proposal and accepted
> it as written, including the recommended default on every fork (F1-F8), so the
> forks are answered and a build round may proceed. The document itself is still
> spec only: it contains no code. The blocking spike is answered in
> [`spike.md`](spike.md).

## Overview

`canary-rewind` takes a failed test from a recorded run, restores as much of
that run's context as the history store actually holds, reruns the one test in
that context, and diffs the outcome against the nearest green run. Its defining
rule comes from the issue: **never silently approximate.** Every replay reports,
per dimension, what was restored, what was not, and why.

The spike found that today's history holds a commit SHA (sometimes the literal
`local`) and test identity, and nothing else a replay needs: no seed, no
execution order, no environment. So the work splits into a **capture** half that
makes future records replayable, and a **replay** half that is honest about
records that are not.

### Goals

1. Given a run id and a failed test, rerun that test at the recorded commit and
   report the result alongside a per-dimension fidelity table.
2. Refuse, with a named reason, whenever a required dimension (the commit)
   cannot be restored, instead of running against today's tree.
3. Extend `canary history record` to capture seed, order and an environment
   fingerprint when the report or environment provides them, additively and
   without breaking existing readers.
4. Diff the replayed failure against a defined "nearest green" run.
5. Hand intermittent reproductions to the flakiness surfaces rather than
   deciding them itself.

### Out of scope

- Restoring network state, database contents, wall-clock time, external service
  versions or secrets. These are always listed as "not restored".
- Replaying a whole run (only one failed test, optionally its preceding file
  order; see F4).
- Container or VM snapshotting of the original runner.
- Automatic fixing, quarantine or issue filing.

## Spike summary

| Dimension   | Today                                 | After capture phase                               |
| ----------- | ------------------------------------- | ------------------------------------------------- |
| Commit      | partial (`local` default, no check)   | required non-`local`, reachability checked        |
| Test id     | name + absolute file path             | name + repo-relative path                         |
| Seed        | absent                                | recorded when passed or detected; else `unknown`  |
| Order       | report order only                     | per-file start order where the report carries it  |
| Environment | `env` column exists, never populated  | fingerprint: runner + version, Node, OS, arch, CI |
| Traces      | separate `run.json`, no shared run id | optional link by run id (F7)                      |

## Forks for the human

Each fork records where the brainstorming method would have asked. The default
applies until overridden.

| #   | Question                                               | Options                                                                                                                 | Recommended default                                                                    | Reason                                                                                                                                                                 |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Build capture before replay, or replay on today's data | (a) capture first; (b) replay first, fidelity table shows gaps; (c) both in one PR                                      | **(a) capture first**                                                                  | The spike shows a replay today restores only the commit. Shipping replay first produces a tool whose table says "not restored" for three of four rows on every record. |
| F2  | Where the new capture fields live                      | (a) optional fields on the existing run record, `schema_version` bump; (b) a sidecar `replay-context.json` per run      | **(a) optional fields, version bump**                                                  | One store, one reader guard (#701). A sidecar can drift from its run and needs its own retention story.                                                                |
| F3  | How the seed is obtained                               | (a) `--seed` flag only; (b) flag plus per-runner detection from report or config; (c) canary injects a seed at run time | **(b) flag, plus detection only where the report carries it**                          | (c) makes canary a runner wrapper. Detection from logs is guessing; a seed that is not certain is recorded `unknown`, never inferred.                                  |
| F4  | What "replay in original order" means                  | (a) the failed test alone; (b) the failed test plus the files that started before it in the same worker; (c) whole run  | **(a) alone first, (b) as an opt-in `--with-predecessors`**                            | (a) is cheap and answers "does it fail in isolation". (b) is the order-dependence case `canary-savant` already bisects, so hand off rather than rebuild bisection.     |
| F5  | Definition of "nearest green"                          | (a) commit distance on first-parent history; (b) most recent by time; (c) same shard/worker                             | **(a) fewest first-parent commits back from the failing SHA, same suite, test passed** | Commit distance isolates the code change, which is what a diff is for. Time mixes unrelated merges; shard identity is not recorded.                                    |
| F6  | Unreachable commit                                     | (a) refuse, exit 3 with reason; (b) fetch then refuse; (c) fall back to nearest reachable ancestor                      | **(b) one `git fetch` of the SHA, then refuse with exit 3**                            | Shallow clones are the common case and one fetch fixes them. (c) is the silent approximation the issue forbids.                                                        |
| F7  | Traces link to `canary-instrument`                     | (a) out of v1; (b) record `run_id` inside `run.json` so rewind can attach it                                            | **(a) out of v1, tracked as a follow-up**                                              | Playwright-only, separate artifact lifecycle; not needed to answer "does it still fail".                                                                               |
| F8  | Surface shape                                          | (a) CLI only; (b) skill only; (c) CLI `canary rewind` for facts and replay, skill for interpretation                    | **(c) CLI plus thin skill**                                                            | Matches `canary batwoman` and `canary briefing` splits: deterministic half testable without an LLM.                                                                    |

### Approaches considered

1. **Replay on today's data with a fidelity table.** Cheapest; honest by
   construction, but nearly every row reads "not restored". Rejected as the
   first deliverable (F1), kept as the replay design.
2. **Runner wrapper that owns seed and order.** Highest fidelity, but turns
   canary into a test runner and breaks its reader-of-reports position.
   Rejected.
3. **Capture additively at record time, then replay (chosen).** Fidelity grows
   with the records; old records still replay commit-only and say so.

## Technical design

### Capture phase (extends `canary history record`)

New optional run fields (all nullable; absent means `unknown`, never zero):

```json
{
  "schema_version": 3,
  "replay": {
    "seed": "12345 | null",
    "seed_source": "flag | report | null",
    "runner": { "name": "vitest", "version": "x.y.z" },
    "node": "v22.x",
    "os": "linux",
    "arch": "x64",
    "ci": "github-actions | null",
    "commit_source": "flag | GITHUB_SHA | null"
  }
}
```

Per test: `test_file` normalised to repo-relative, plus optional `start_index`
(file start order where the report has per-file `startTime`).

Rules: `commit_sha` of `local` is still accepted for recording but stamps
`commit_source: null`, which makes the run non-replayable. No environment
variable values beyond the names above are captured (secret hygiene).

### Replay phase

```text
canary rewind <run_id> --test <name> [--with-predecessors] [--json]
  -> load run from AsyncHistoryStore (makeStore)
  -> commit: git cat-file -e <sha> || git fetch origin <sha> || abstain(3)
  -> git worktree add <scratch> <sha>             (never touches the user's tree)
  -> build per-dimension plan: restored | not-restored(reason) | not-recorded
  -> run the single test with recorded seed where supported
  -> repeat N times (default 3) to classify: reproduced | not-reproduced | intermittent
  -> find nearest green (F5), diff: commit range, error_text, duration, env fingerprint
  -> print fidelity table + result; intermittent -> hand-off line to flake surfaces
  -> remove scratch worktree
```

Exit codes: 0 replay completed (any outcome); 3 abstained (run or test not
found, commit unreachable, `local` commit, unsupported runner); never 1 for a
reproduced failure — the finding is content.

## Integration points

### Entry points

- `canary history record`: new capture fields (capture phase PR).
- New subcommand `canary rewind` and skill
  `agents/skills/claude-code/canary-rewind/`.

### Registrations required

- Register `rewind` in `ts/src/cli.ts`; layer assignment for the new module
  (consumes `history/`, never the reverse).
- Skill manifest and `requires:` frontmatter checked by `canary doctor`.

### Ratchet cost (known, budget before the build PR)

A new CLI surface trips three CI ratchets that local gates do not show:

- **Perf delta:** a new module adds complexity identities; the delta rule has no
  waiver (`--admin` cannot bypass it), so the build PR must pay down an
  equivalent amount elsewhere or keep the new functions under threshold.
- **Entropy `entryPoints`:** the new `src` module and any `scripts/lib/*.mjs`
  must be declared in **both** `entropy.entryPoints` arrays; never raise
  `maxFindings`.
- **Architecture:** a layer allowance and the arch floor bump for the new module
  edge into `history/`.

### Documentation updates

- `AGENTS.md` run-history paragraph (schema v3 fields) and skill list.
- A guide `docs/guides/rewind.md` with the fidelity-table vocabulary.

### Architectural decisions

- F2 (schema v3 with a `replay` block) changes the on-disk contract between the
  recorder and every history consumer and warrants an ADR alongside
  [ADR 0013](../../knowledge/decisions/0013-history-store-async-interface.md).

## Success criteria

1. When `canary history record` is given `--seed 42`, the written line shall
   carry `replay.seed: "42"` and `replay.seed_source: "flag"`; without it and
   with no seed in the report, both shall be `null`.
2. Every record written after the capture phase shall carry non-null
   `replay.runner.name`, `node`, `os` and `arch`, and a repo-relative
   `test_file` (a test asserts no path starts with `/` or a drive letter).
3. Records written before the capture phase shall still load; a replay of one
   shall list seed, order and environment as `not-recorded`.
4. **(abstention)** When the run id or test is absent, the commit is `local`, or
   the commit is unreachable after one fetch, `canary rewind` shall print
   `Abstained:` with the reason, create no worktree, and exit 3.
5. The replay output shall contain one row per dimension (commit, seed, order,
   environment, network, database, wall-clock) with exactly one of `restored`,
   `not-restored`, `not-recorded`; network, database and wall-clock shall always
   be `not-restored`.
6. When the replay environment fingerprint differs from the recorded one, the
   environment row shall read `not-restored` and name each differing key; it
   shall never read `restored`.
7. Given a fixture history where the failing run's first-parent ancestors
   include green runs at distance 2 and 5, the nearest green shall be the
   distance-2 run.
8. When the test fails in some but not all of N repeats, the result shall be
   `intermittent` and the output shall include the flakiness hand-off line.
9. After any exit, the user's working tree and branch shall be unchanged and no
   scratch worktree shall remain (asserted by `git worktree list` before and
   after).
10. `canary rewind` shall never exit 1.

## Implementation order

1. **PR 1 — capture:** schema v3 `replay` block, repo-relative `test_file`,
   reader updates, ADR; criteria 1-3.
2. **PR 2 — replay CLI:** `canary rewind` with abstention, scratch worktree,
   fidelity table, nearest green; criteria 4-10. Pays the ratchet cost above.
3. **PR 3 — skill:** `canary-rewind` interpretation layer and hand-offs.

## Assumptions

- Git is available and the history store is readable from the replay host.
- Vitest, Playwright and JUnit-producing runners are the only supported runners
  in v1; others abstain.
- The dogfood workflow will pass `--seed` once capture ships, providing the
  first replayable real records.

## Accepted risks

- Rerunning at an old commit needs that commit's dependencies installed; an
  install failure is reported as `environment: not-restored`, not as a replay
  result.
- Seed replay is only as deterministic as the runner's own seed handling.
- Nearest green by commit distance can miss a green run on a sibling branch.
