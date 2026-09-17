# CLI command barrel: stop `ts/src/cli.ts` import count tracking the command count

**Issue:** #988 · **Route:** feature (autonomous brainstorm, forks settled by a
human)

**Keywords:** cli, commander, barrel, import-count, perf-ratchet,
deltaAllowances

## Overview

`ts/src/cli.ts` imports every sub-app builder directly (`ts/src/cli.ts:23-58`),
so each new subcommand adds one import. `harness check-perf` reports
`File has 19 imports (threshold: 15)` for it, suppressed on the merge-base delta
rule only by a placeholder `deltaAllowances` entry (`import-count` /
`ts/src/cli.ts`, `.harness/perf-baseline.json`, added by PR #985) that says it
should be pruned when this lands.

**Goal:** adding a subcommand no longer changes `cli.ts`'s import count, with
the registered command set byte-identical.

**Out of scope:** the `cli.ts` file-length finding (403 > 300), the inline
commands backed by `cli-commands.ts` (kept untouched to avoid conflicts with
open PR #1036), and any change to command behavior.

## Decisions made

| Decision                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Barrel module (option 1 in #988) over a registration table or dynamic import      | Human-answered fork. Cheapest change; keeps static analysis (dead-export, arch) able to see the wiring. Dynamic import rejected in the issue itself.                                                                                                                                                                                                                                                  |
| Barrel lives at `ts/src/commands/cli.ts`                                          | Matches the `cli` arch layer (`ts/src/**/*cli*.ts`), so `check-deps` allowed dependencies are unchanged, and matches the existing reviewed `coupling` / `ts/src/**/cli.ts` allowance. A barrel is by definition a coupling-ratio-1.00 file; a name outside that glob would introduce a new coupling finding and move the problem rather than fix it. `ts/src/commands/index.ts` would match no layer. |
| Barrel re-exports only the 15 `build*Command` / `create*Command` sub-app builders | Keeps the barrel itself at 15 module imports, at (not over) the 15 threshold. `cli-commands.ts`, `cli-common.ts`, `main-deps.ts` and `commander` stay as direct imports: they are not per-subcommand.                                                                                                                                                                                                 |
| Prune the `import-count` / `ts/src/cli.ts` allowance in the same PR               | Required by #988 acceptance.                                                                                                                                                                                                                                                                                                                                                                          |

Approaches considered: (A) barrel — chosen; (B) registration table
`{name, build}` iterated by a loader — removes the per-command edit in `cli.ts`
too, but is a larger refactor and changes the registration order mechanism; (C)
dynamic import — breaks static analysis.

## Technical design

- New `ts/src/commands/cli.ts`: `export { buildXCommand } from '../x-cli.js'`
  for each of the 15 sub-app builders.
- `ts/src/cli.ts`: replace the 15 imports with one
  `import { ... } from './commands/cli.js'`. The `addCommand` order is
  unchanged.
- Declare `ts/src/commands/cli.ts` in `entropy.entryPoints` and
  `performance.entryPoints` in `harness.config.json`.
- Remove the `import-count` / `ts/src/cli.ts` entry from
  `.harness/perf-baseline.json` `deltaAllowances`.

**Known risk:** the barrel will reach the import threshold itself after one or
two more sub-app modules. That is a fan-out file doing its job; the recurrence
is noted in the PR rather than pre-solved (YAGNI).

## Integration Points

- **Entry Points:** new internal module `ts/src/commands/cli.ts`; no new CLI
  command.
- **Registrations Required:** `entropy.entryPoints` + `performance.entryPoints`
  in `harness.config.json`.
- **Documentation Updates:** none user-facing; the `cli.ts` header comment notes
  the barrel.
- **Architectural Decisions:** None (small change).
- **Knowledge Impact:** "new sub-app builders are added to
  `ts/src/commands/cli.ts`".

## Success Criteria

1. When `harness check-perf` runs, it shall report no `import-count` finding for
   `ts/src/cli.ts` and no new finding for `ts/src/commands/cli.ts` outside
   existing allowances.
2. The top-level command names and order registered by `createCanaryCommand()`
   shall be identical before and after, proven by a snapshot test.
3. `harness check-deps` shall pass unchanged.
4. The `import-count` / `ts/src/cli.ts` `deltaAllowances` entry shall be absent
   and the perf ratchet shall still pass.
5. build, typecheck, format:check and test gates in `ts/` pass.

## Implementation Order

1. Test first: pin the registered command name list (fails nothing today; guards
   the refactor).
2. Add barrel, rewire `cli.ts`, declare entryPoints.
3. Prune allowance; re-measure `check-perf` / `check-deps`.
