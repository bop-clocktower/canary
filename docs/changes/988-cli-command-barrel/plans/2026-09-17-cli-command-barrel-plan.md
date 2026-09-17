# Plan: CLI command barrel (#988)

**Spec:** docs/changes/988-cli-command-barrel/proposal.md · **Rigor:** fast
(single phase, 4 tasks, auto-approved: no approval signal fired)

## Task 1: Pin the registered command set (test first)

- Add `ts/test/cli-command-registry.test.ts`: assert
  `createCanaryCommand(...).commands.map(c => c.name())` equals the literal list
  captured from `origin/main` 426bb332, in order. Run it green on the unchanged
  tree (it is a regression guard for a behavior-preserving refactor).
- Also assert `ts/src/cli.ts` has at most 5 module imports, which fails before
  Task 2 (the red step).

## Task 2: Barrel + rewire

- Create `ts/src/commands/cli.ts` re-exporting the 15 sub-app builders.
- Replace the 15 imports in `ts/src/cli.ts` with one import from
  `./commands/cli.js`. Keep `addCommand` order.
- Test from Task 1 goes green.

## Task 3: Ratchet registrations

- Add `ts/src/commands/cli.ts` to `entropy.entryPoints` and
  `performance.entryPoints` in `harness.config.json`.
- Remove the `import-count` / `ts/src/cli.ts` entry from
  `.harness/perf-baseline.json` `deltaAllowances`.

## Task 4: Verify

- From `ts/`: `npm ci`, `npm run build`, `npm run typecheck`,
  `npm run format:check`, `npm test`.
- `harness check-perf` before/after: no import-count finding for
  `ts/src/cli.ts`, no new identity outside existing allowances;
  `harness check-deps` passes.
