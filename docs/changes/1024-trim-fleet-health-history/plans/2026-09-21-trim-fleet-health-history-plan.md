# Plan: trim the fleet-health history store to the newest 50 runs

Issue: [#1024](https://github.com/bop-clocktower/canary/issues/1024) Route:
feature · Pipeline: `harness:brainstorming` → `harness:autopilot` Date:
2026-09-21 · Base: `origin/main` @ `5f5d40af`

---

## 1. EXPLORE — what is actually true

`#1024` was written against `9e756fe5` on 2026-09-16. Every claim in it was
re-derived against `5f5d40af` before any code was written.

| Claim in #1024                                                     | Verdict                    | Evidence (re-measured 2026-09-21)                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The store is `test-results/reports/history-v2.jsonl`               | Correct                    | `DEFAULT_HISTORY_FILE` in `ts/src/history/cli.ts`; `DEFAULT_NDJSON_PATH` in `ts/src/history/store.ts`.                                                                        |
| `fleet-health` restores before `record` and saves after            | Correct                    | `.github/workflows/dogfood.yml`, steps `Restore run history` → `Run the suite and record it` → `Save run history` (the save is gated on `steps.record.outcome == 'success'`). |
| The store is append-only and unbounded on write                    | Correct                    | `NdjsonHistoryStore.pushRun` (`ts/src/history/ndjson-store.ts`) is a bare `appendFileSync`; nothing in `ts/src` prunes, caps or rotates the file.                             |
| Each run saves a new immutable cache entry holding the whole store | Correct                    | The cache key carries `run_id` and `run_attempt`, so no entry is ever overwritten — each run reserves a fresh one.                                                            |
| One run = 1,657,180 bytes / 4,693 rows / 121,301 gzipped           | **Stale, and understated** | One recorded run of canary's own vitest suite at `5f5d40af` is **1,824,467 bytes of NDJSON, 4,924 test rows, 130,719 bytes gzipped**. About 10% larger in five days.          |

So: the defect is real, it is exactly where #1024 says it is, and it is growing
slightly faster than the issue's own numbers imply. The per-run cost to use is
**~0.125 MB gzipped**, and today the number of runs in an entry is unbounded.

Read-side windows that a trim must never starve:

| Consumer                    | Window  | Source                                                |
| --------------------------- | ------- | ----------------------------------------------------- |
| Flake verdict minimum       | 10 runs | `MIN_WINDOW_RUNS` in `ts/src/util/flake-window.ts:40` |
| `history flaky` / `analyze` | 30 runs | `--window` default in `ts/src/history/cli.ts`         |

## 2. EVALUATE — the fork, and the one sub-decision left

The three-way fork in the issue body was settled by the human at this run's
CONFIRM gate: **trim to the newest N runs before saving, N = 50.** Save-on-main
only and leave-it-and-watch were considered and rejected. That is not
re-litigated here.

N = 50 is 5x the flake minimum and 1.67x the analyze window, so a trimmed store
can never starve either reader, and it caps the cache entry at roughly 6.4 MB
gzipped instead of growing without limit.

The one sub-decision the human did not settle, and which is answerable from the
code rather than a fork worth parking on: **where the trim lives.**

|              | A) `tail -n 50` in the workflow                | B) Store method + `canary history trim`              | C) Cap inside `pushRun`                    |
| ------------ | ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Effort       | Lowest                                         | Medium                                               | Low                                        |
| Testable     | Only as workflow text; no behavior to assert   | Unit-testable: boundary, ordering, post-trim windows | Unit-testable                              |
| Ordering     | Append order only; blind to `timestamp`        | Honors the same time order every reader sorts by     | Honors it                                  |
| Blast radius | CI only                                        | CI only; opt-in everywhere else                      | **Every consumer's local store, silently** |
| Contract     | Leaves 460's write contract intact by accident | Amends it explicitly and narrowly                    | Breaks 460's stated contract for everyone  |

**Chosen: B.** C is rejected outright — capping on every write would silently
destroy history for every consumer who never asked for retention, which is the
opposite of what proposal 460 A5 promises them. A is rejected because required
artifact 3 (prove a trimmed store still satisfies the 30-run analyze window)
cannot be honestly satisfied by asserting on shell text; a gate over a `tail`
invocation tests that the string is present, not that the window holds.

## 3. PRIORITIZE — the contract amendment

Proposal 460 says: _"Local store retention stays unbounded on write; windows
stay read-side."_

Approach B amends that sentence rather than violating it, and the amendment is
stated in the PR body and in `AGENTS.md`:

> Retention stays unbounded **on write** — `history record` still only appends,
> so nothing a consumer records is ever dropped behind their back. Retention is
> now available as a **separate, explicit, opt-in operation**
> (`canary history trim --keep <n>`), which canary's own CI applies to its
> cached store between `record` and the cache save. Windows stay read-side and
> are unchanged.

The distinction that keeps this honest: the writer's contract is untouched; a
new caller-invoked verb was added next to it.

## 4. Tasks (TDD — test first in every one)

1. **RED:** `ts/src/history/ndjson-store.test.ts` — `trimToNewest`:
   - a store below `keep` is untouched (file bytes identical);
   - a store at **exactly** `keep` is untouched (the boundary);
   - a store **above** `keep` keeps the newest `keep` by `timestamp`, drops the
     oldest, and returns `{ before, after, removed }`;
   - trimming preserves each surviving row's ORIGINAL bytes (no re-serialize),
     so a field this version does not model is not silently dropped;
   - a missing file is a no-op, not a throw;
   - a run appended out of time order is ranked by `timestamp`, not by position.
2. **GREEN:** implement `trimToNewest` in `ts/src/history/ndjson-store.ts`.
3. **RED:** `ts/test/history-trim-windows.test.ts` — the window proof: build a
   60-run store, trim to 50, then assert `querySummary(suite, 30)` still reads
   **30** runs and `queryFlaky(30, ...)` still sees a 30-run denominator; and
   that the flake minimum of 10 is satisfied with margin.
4. **RED/GREEN:** `ts/test/history-cli-trim.test.ts` —
   `canary history trim --keep <n>` prints what it removed, supports `--json`,
   rejects `--keep 0` through the existing `parseRunCount` guard, and refuses
   when a remote `--db-url` is configured (trim is a local-file operation and
   silently no-opping against Supabase would be a false green).
5. **GREEN:** register the `trim` subcommand in `ts/src/history/cli.ts`.
6. `ts/test/workflow-false-green.test.ts` — assert the workflow trims
   **between** `record` and `Save run history`, and that the `--keep` value in
   the workflow is >= the 30-run analyze window (so the two can never drift
   apart silently).
7. Wire `.github/workflows/dogfood.yml`: a `Trim run history` step after
   `record`, before `Save run history`, `--keep 50`.
8. `AGENTS.md` run-history section: state the trim and the amended contract.
9. Probe every new gate by reverting the fix and watching it go red.
10. Four gates from `ts/`, ratchets, prettier, PR.

## 5. Risks

- **New CLI surface trips CI-only ratchets** (dead exports, perf complexity,
  arch allowance) that the local gates do not catch. Mitigation: no new module
  and no new `scripts/lib/*.mjs`, so no `entropy.entryPoints` change is needed;
  the method lands in the existing `ndjson-store.ts` and the subcommand in the
  existing `cli.ts`. Watch CI, do not raise `maxFindings`.
- **A trim that drops a run a reader wanted** is the failure mode that matters.
  Guarded by task 3 (the window proof) and task 6 (the workflow's `--keep` can
  never fall below the analyze window without a red test).

## 6. Amendment after the first CI run — where the code lives

The first push was red on two ratchets the local gates cannot see, exactly the
risk section 5 named. Both were real, and neither was about the trim's
behaviour:

| Ratchet            | Finding                                                                    | Cause                                                                                       |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| arch (module size) | `ts/src/history` 1954 > 1800 LOC, NEW                                      | The module sits **exactly** on its 1800 ceiling. Any line added to it regresses.            |
| perf (delta)       | `ts/src/history/cli.ts` 16 imports > 15; `ndjson-store.ts` 339 lines > 300 | Same ceiling problem one level down: that CLI module is exactly on the 15-import threshold. |
| canary-savant      | SV004 order-coupled name in a doc comment                                  | A comment said "... before the cache save"; reworded.                                       |

The resolution keeps the behaviour and the UX (`canary history trim`) and moves
where the code is mounted:

- The implementation lives in a **new module directory**,
  `ts/src/history/retention/` (`trim.ts` + `command.ts`), mirroring the existing
  `flake/`, `keys/` and `formats/` siblings. A subdirectory is its own arch
  module, so `ts/src/history` and `ts/src/history/ndjson-store.ts` are left
  **byte-identical to `main`**.
- The subcommand is registered from `ts/src/commands/engine/cli.ts` — the
  registry #988 added so "a new subcommand adds one import to ONE domain
  registry" instead of taxing the module it belongs to. That registry is capped
  at 12 imports and holds 5.

This is paydown, not an allowance: no `deltaAllowances` entry was added and no
baseline was refreshed. `harness check-arch` reports no new violation locally.

Cost of the move, stated plainly: `registerTrimCommand` is mounted a layer away
from the other `history` subcommands, so a reader of `history/cli.ts` will not
see `trim` there. The registry comment names the reason.
