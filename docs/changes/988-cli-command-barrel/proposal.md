# CLI command registry: stop any module's import count tracking the command count

**Issue:** #988 · **Route:** feature (autonomous brainstorm, forks settled by a
human; reworked after human review of PR #1038)

**Keywords:** cli, commander, registry, import-count, perf-ratchet,
deltaAllowances

## Overview

`ts/src/cli.ts` imported every sub-app builder directly, so each new subcommand
added one import. `harness check-perf` reported
`File has 19 imports (threshold: 15)` for it, suppressed on the merge-base delta
rule only by a placeholder `deltaAllowances` entry (`import-count` /
`ts/src/cli.ts`, added by PR #985) that says it should be pruned when this
lands.

**Goal:** adding a subcommand must not grow the import count of any single
module past the 15 threshold in a way that recurs on every command, with the
registered command set byte-identical.

**Out of scope:** the `cli.ts` file-length finding, the inline commands backed
by `cli-commands.ts` (PR #1036 owns that file), and any change to command
behavior.

## Rework (human review of PR #1038)

The first cut was a single barrel, `ts/src/commands/cli.ts`, holding all 15
builders: exactly at the threshold, so the next subcommand would trip the same
rule there. The problem moved rather than being fixed. The human rejected it and
chose the **registry array** option.

## Decisions made

| Decision                                                       | Rationale                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry array; `cli.ts` loops over `COMMANDS`                 | Human decision on PR #1038. `cli.ts` imports no sub-app builder at all, so its import count (5) is independent of the command count.                                                                                                           |
| Split into per-domain registries, not one flat array           | A single registry file would still gain one import per command and hit 15 again. Splitting by domain means a command grows ONE small file; the aggregator only grows when a whole domain opens. Growth is bounded structurally, not postponed. |
| Four domains: `engine`, `project`, `audit`, `readiness`        | Chosen as contiguous runs of the existing registration order, so concatenating them preserves help order byte-for-byte with no sort key. `engine` (history/analyze/guardian) also owns the out/err sink forwarding those factories need.       |
| Every registry file is named `cli.ts` under `ts/src/commands/` | Keeps them in the `cli` arch layer (`ts/src/**/*cli*.ts`) and under the existing reviewed `coupling` / `ts/src/**/cli.ts` allowance; a registry is coupling-ratio 1.00 by definition. No new allowance.                                        |
| Test caps every module under `ts/src/commands/` at 12 imports  | 3 below the gate's threshold, so the unit test fails before the perf ratchet would, pointing at the rule for where a command goes. Denominator guard asserts at least 5 registry files were scanned.                                           |
| Prune the `import-count` / `ts/src/cli.ts` allowance           | Required by #988 acceptance; stays removed.                                                                                                                                                                                                    |

Approaches considered: (A) single barrel — shipped first, rejected in review
(sits at 15); (B) registry array — chosen, split by domain; (C) dynamic import —
breaks static analysis.

## Technical design

- `ts/src/commands/{engine,project,audit,readiness}/cli.ts` each export a
  `ReadonlyArray<(deps: MainDeps) => Command>`.
- `ts/src/commands/cli.ts` exports `COMMANDS`, the concatenation in registration
  order.
- `ts/src/cli.ts`:
  `for (const build of COMMANDS) program.addCommand(build(deps))`.
- All five modules declared in `entropy.entryPoints` and
  `performance.entryPoints`.

### Headroom (imports per module, cap 12, gate threshold 15)

| Module                      | Imports | Headroom to cap                |
| --------------------------- | ------- | ------------------------------ |
| `ts/src/cli.ts`             | 5       | fixed, per-command independent |
| `ts/src/commands/cli.ts`    | 6       | 6 more domains                 |
| `commands/engine/cli.ts`    | 5       | 7 commands                     |
| `commands/project/cli.ts`   | 5       | 7 commands                     |
| `commands/audit/cli.ts`     | 5       | 7 commands                     |
| `commands/readiness/cli.ts` | 8       | 4 commands                     |

### Rule for where a new command goes

Append it to the domain registry it belongs to, at the position it should appear
in help. If that registry is at 12, or the command fits no domain, open a new
folder `ts/src/commands/<domain>/cli.ts`, add it to `COMMANDS`, and declare it
in both entryPoints arrays. Never raise the cap.

## Integration Points

- **Entry Points:** five internal modules under `ts/src/commands/`; no new CLI
  command.
- **Registrations Required:** `entropy.entryPoints` + `performance.entryPoints`.
- **Documentation Updates:** module header comments carry the rule.
- **Architectural Decisions:** None (small change).
- **Knowledge Impact:** "new sub-app builders join a domain registry under
  `ts/src/commands/`".

## Success Criteria

1. `harness check-perf` reports no `import-count` finding for `ts/src/cli.ts` or
   any `ts/src/commands/**` module, and no new finding outside existing
   allowances.
2. Top-level command names and order are identical, proven by the pinned test.
3. No module under `ts/src/commands/` exceeds 12 imports, proven by test.
4. `harness check-deps` passes unchanged.
5. The `import-count` / `ts/src/cli.ts` allowance is absent and the perf ratchet
   passes.
6. build, typecheck, format:check and test gates in `ts/` pass.
