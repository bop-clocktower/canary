# Split `ts/src/history` along the command-family seam (#1074)

## Overview

`ts/src/history` sat at **exactly** its 1800-LOC arch module-size ceiling and
`ts/src/history/cli.ts` at **exactly** the 15-import perf threshold. Zero
headroom in either, so the next `history` subcommand tripped both required
checks on its first CI run — and the perf delta rule is unwaivable here
(`--admin` cannot bypass a red required check), so paydown was the only legal
route.

The fork was decided before this work started: **split along a seam.** Not raise
the ceiling, not refresh a baseline, not add a `deltaAllowances` entry.

## The seam

**One directory per subcommand family**, each with a `cli.ts` that exports a
`register*Command` registrar; `ts/src/history/cli.ts` becomes the command root
and does nothing but build the program and delegate.

| Directory                   | Subcommands                    | Concern                                        |
| --------------------------- | ------------------------------ | ---------------------------------------------- |
| `ts/src/history/record/`    | `record`                       | Capture: runner report -> run -> store         |
| `ts/src/history/publish/`   | `push`, `migrate`              | Publish already-captured history to the remote |
| `ts/src/history/reporting/` | `flaky`, `timeline`, `summary` | Query: answer questions without writing        |
| `ts/src/history/retention/` | `trim`                         | Retention (pre-existing, from #1073)           |

`retention/` is the precedent, not an exception: PR #1073 already put `trim` in
its own directory with its own `cli.ts` for exactly this reason, and documented
the filename constraint in its header. This change applies that shape
retroactively to the five subcommands that were still in the root.

### Why this seam and not another

The issue named store / query / retention / reporting as candidates. Persistence
(`store.ts`, `ndjson-store.ts`, `supabase-store.ts`, `async-store.ts`,
`schema.ts`, `record.ts`) was considered and **rejected as the seam**:

- It is not what grows. The pressure on this module comes from subcommands —
  #1073's `trim` is what pushed it onto the ceiling — and persistence adapters
  have been stable.
- It is imported from ~20 sites across `ts/src/analysis`, `ts/src/order`,
  `ts/src/rewind`, `ts/src/ci-ready-cli.ts` and the test suite. Moving it would
  be a wide-blast-radius rename that lowers a number without separating a
  concern, which is the outcome this issue explicitly did not want.

The command surface, by contrast, separates genuinely: capture writes, publish
republishes, reporting reads. A new `history` subcommand lands on exactly one of
those axes, so the seam pays down the thing that actually grows.

## Decisions made

1. **Family directories, not one `ingest/` + one `reporting/`.** The first cut
   grouped all three write commands into `ingest/cli.ts`. That file came out at
   606 lines and the perf ratchet failed it against the merge base
   (`File has 606 lines (threshold: 300)`) — a _new_ violation, because the path
   was new. `record` and `publish` are separate concerns anyway; the ratchet
   just made that argument for us.
2. **Every family module is named `cli.ts`.** Two constraints force this, both
   already documented in `retention/cli.ts`: layer binding is by filename
   (`ts/src/**/*cli*.ts` is the `cli` layer, first match wins), so a
   `command.ts` binds to the `history` layer and `check-deps` correctly calls
   its `cli-common` import a violation; and the perf baseline's standing
   coupling allowance is globbed at `ts/src/**/cli.ts`, so a differently-named
   module trips the coupling rule as a brand-new finding.
3. **`HistoryDeps` moves to `ts/src/history/cli-deps.ts`, and is re-exported
   from `cli.ts`.** Every family module needs the deps contract; if it stayed in
   the root the root would import its families while they imported it back. A
   type-only cycle is erased, but `defaultHistoryDeps` is a value. `cli.ts`
   keeps `export type { HistoryDeps }` so no caller or test changes.
4. **`record`'s outcome rendering moves to `record/outcome-cli.ts`.** `record`
   alone was over the 300-line file threshold. The split is real rather than
   arithmetic: `cli.ts` decides whether to record, `outcome-cli.ts` describes
   what happened (`--json` payload, dry-run line, success line, and the
   empty-report abstention). They share `countsLine`, which is what stops the
   `--json` shape and the human line from drifting.
5. **No behavior change.** No option, no output line, no exit code moved. The
   only observable difference is `--help` ordering, which follows the lifecycle
   (`record`, `push`, `migrate`, `flaky`, `timeline`, `summary`) and is pinned
   by the new guard test.

## Measurements

Measured at base SHA `76d3f19b`, harness CLI 12.10.0, in this branch's own
worktree. Module LOC is read by planting a known-size probe file in the module
and reading the reported total back (the metric is not otherwise printed);
`.test.ts` files are excluded from it entirely, comments are counted.

| Metric                           | Before | After | Ceiling | Headroom created |
| -------------------------------- | ------ | ----- | ------- | ---------------- |
| `ts/src/history` module LOC      | 1800   | 1093  | 1800    | **+707**         |
| `ts/src/history/cli.ts` imports  | 15     | 6     | 15      | **+9**           |
| `ts/src/history` top-level files | 9      | 10    | 12      | -1               |

New modules, each with its own ceiling:

| Module                     | LOC | Ceiling |
| -------------------------- | --- | ------- |
| `ts/src/history/record`    | 378 | 1800    |
| `ts/src/history/publish`   | 225 | 1800    |
| `ts/src/history/reporting` | 262 | 1800    |

**This measurement's base does not include two merged-before-us peers.** PR 1078
(issue 1057) removes ~35 LOC of non-test source from `ts/src/history`, and PR
1083 (issue 990) deletes `classifyFlakeTrend`, `FlakeTrend` and
`TREND_THRESHOLD` from `detector.ts` (44 deletions across 2 source files).
Neither is in this branch. The post-merge absolute will therefore be lower than
1093; **the delta this change contributes — roughly 700 LOC of headroom — is the
number to hold it to**, and it is independent of what those two move.

## Acceptance, demonstrated

The issue's first criterion is that adding a new `history` subcommand no longer
trips either wall on its first CI run. Demonstrated rather than asserted: a
plausible 147-line subcommand (`ts/src/history/prune/cli.ts`, one registrar, one
root import) was planted, measured, and removed.

| What it costs                         | Measured                                             | Limit           |
| ------------------------------------- | ---------------------------------------------------- | --------------- |
| `ts/src/history` module LOC growth    | +2                                                   | 707 of headroom |
| New `ts/src/history/prune` module LOC | 145                                                  | 1800            |
| `ts/src/history/cli.ts` imports       | 7                                                    | 15              |
| New file length                       | 147                                                  | 300             |
| New coupling finding                  | allowed by the standing `ts/src/**/cli.ts` allowance | —               |

Before the split, that same subcommand added ~150 LOC to a module already at
1800 and a 16th import to a file already at 15 — both walls, on the first run.

**One caveat recorded rather than buried:** the planted subcommand did move the
repo-wide aggregate `module-size` metric in `.harness/arch/baselines.json`
(45778 -> 46356). That is the general arch-floor behavior for any PR that adds
code, not the `history` ceiling, and it is what per-PR allowances exist for.
This change itself does not regress it — `scripts/arch-verdict.mjs` reports
`BASELINE TRIP: 0 new violation(s) from this change` and exits 0.

## Integration points

- **Entry points.** No new CLI surface. `canary history` keeps all six
  subcommands; `history trim` keeps mounting from the #988 domain registry in
  `ts/src/commands/engine/cli.ts`, unchanged.
- **Registrations required.** None. `ts/src/commands/engine/cli.ts` still
  imports `createHistoryCommand` from `ts/src/history/cli.js`. No
  `entropy.entryPoints` / `performance.entryPoints` entry is needed: the new
  modules are reachable from `ts/src/main.ts` through ordinary imports, the same
  reason `retention/` needed none in #1073.
- **Documentation updates.** None found. `AGENTS.md` mentions `ts/src/history`
  once, as the worked example of a module that merged oversized (#959); the
  sentence is still true and is about the gate, not the layout.
- **Architectural decisions.** None rising to an ADR. This applies an
  established in-repo pattern (#988 registries, #1073's `retention/`) rather
  than setting a new one.
- **Knowledge impact.** The rule worth carrying forward: _a new `history`
  subcommand opens its own `<family>/cli.ts`; it does not grow the root._ It is
  recorded in the root module's header and enforced by
  `ts/test/history-seam.test.ts`.

## Success criteria

1. `ts/src/history` is materially under its ceiling and `ts/src/history/cli.ts`
   materially under 15 imports, both measured, with the base SHA stated.
2. A plausible new subcommand costs +2 LOC in `ts/src/history` and +1 import in
   the root — measured, not asserted.
3. No behavior change: the full suite passes unchanged, and the registered
   subcommand set is pinned by name and order.
4. The headroom is defended locally. `ts/test/history-seam.test.ts` fails at the
   desk when the root regrows — all three ratchets that would otherwise catch it
   are CI-only, which is how #1074 came to exist.
5. Every CI-only ratchet reproduced locally against the merge base and green:
   perf (identity delta), entropy, docs, `arch-verdict`.

## Implementation order

1. Extract `HistoryDeps` / `defaultHistoryDeps` to `cli-deps.ts`.
2. Move `flaky` / `timeline` / `summary` to `reporting/cli.ts`.
3. Move `push` / `migrate` to `publish/cli.ts`.
4. Move `record` to `record/cli.ts`, splitting outcome rendering into
   `record/outcome-cli.ts`.
5. Reduce `cli.ts` to the command root.
6. Add `ts/test/history-seam.test.ts`.
7. Reproduce the four CI-only ratchets locally against `76d3f19b`.
