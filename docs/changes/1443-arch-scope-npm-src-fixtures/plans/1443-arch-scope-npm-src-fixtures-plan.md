# #1443: check-deps reads npm/src; fixtures leave the arch and entropy denominators

Pipeline: `harness:debugging` (investigate, analyze, hypothesize, fix).
cicd-fleet run fc1022. Measured in a fresh worktree of `origin/main` 871649d5
with harness CLI 13.0.0, Node 22.23.2.

## Root cause

1. **npm/src is unlayered.** `runCheckDeps` discovers files only through the
   layer patterns (`findFiles(pattern)` for each layer), so a root no pattern
   matches is never read. The 13 layers cover `ts/src/**`,
   `agents/skills/claude-code/**` and `agents/skills/lib/**`. Nothing matched
   `npm/src`, so check-deps reported 468 modules and passed with a cycle planted
   there.
2. **Fixtures are inside both analyzers.** `architecture.excludePatterns` was
   unset (schema default `[]`) and `entropy.excludePatterns` had no fixtures
   pattern. Reproduced on the real tree: a planted `ts/test/fixtures/zz1443/`
   (value cycle, dead exports, 2005-line module) moved arch `newViolations` 0 to
   2 and entropy 140 to 2146. Under `ts/test/fixtures/.zz1443dot/` it moved arch
   by 1 (the cycle: circular-deps walks dot-dirs, module-size does not) and
   entropy to 2146.
3. **Dot-dir subtlety.** The arch collectors match excludes with minimatch
   `{dot: true}`; the entropy analyzer matches with minimatch defaults
   (`dot: false`), where `**/test/fixtures/**` does not match
   `ts/test/fixtures/.x/a.ts`. So entropy needs a second pattern,
   `**/test/fixtures/**/.*/**`.

## Fix

- `harness.config.json` layers: `npm-reporter` (`npm/src/reporters/**`, allows
  nothing) declared before `npm-cli` (`npm/src/**`, allows `npm-reporter`).
  Binding is first-match, so the order is load-bearing. `npm/src/reporters` is
  published separately (`canary-test-cli/reporter`) and imports nothing outside
  itself today, so it is the leaf, the same two-sided shape as `skills` /
  `skills-lib` (#1155). npm/src imports only itself and node builtins, so no
  other layer's `allowedDependencies` changes.
- `architecture.excludePatterns` and `entropy.excludePatterns`: add
  `**/test/fixtures/**` and `**/test/fixtures/**/.*/**` (both lists carry both,
  so neither depends on the dot semantics of its matcher).
- Remove `ts/test/fixtures/schedule-staleness/gh-stub.cjs` and
  `ts/test/fixtures/async-pipe-exit-probe.cjs` from both `entryPoints` lists.
  They existed only to stop fixtures reading as dead code; inside an excluded
  path they root nothing.

## Tests (each seen failing first)

- `ts/test/harness-config-denominator.test.ts`: `npm/src` joins `SOURCE_ROOTS`
  (every tracked module inside a layer, 30/30); a new #1443 block asserts
  reporter files bind `npm-reporter`, the rest bind `npm-cli`, the direction,
  and that new paths anywhere under npm/src would bind. Failed 4 without the
  fix.
- `ts/test/analysis-scope-rehearsal.test.ts` (new, live CLI on a throwaway
  project):
  - check-deps on a copy of npm/src under the real config: analyses >= 30
    modules and passes; a value cycle, an `import type` cycle and a
    reporter-to-CLI import each fail it, over a full denominator (module delta
    equals the planted file count) and naming the planted file. Without the fix
    it reported 0 modules.
  - fixture rehearsal under the real exclude config: broken modules planted in
    `ts/test/fixtures/planted`, `.planted-dot`, `nested/.planted-dot` and
    `agents/skills/test/fixtures/planted` leave every arch category value and
    the entropy count unchanged, while the same plant under `ts/src` moves them
    (positive control). Without the fix circular-deps went 0 to 4.
  - Abstains out loud (`reportAbstention`) where `harness` is not on PATH. The
    `ts-validate` CI job does not install it, so in CI only the offline tests
    run.
- `ts/test/entropy-entrypoints.test.ts`: no entry point may match
  `entropy.excludePatterns` (`path.matchesGlob`, same default semantics as the
  entropy matcher). Failed 2 (the two fixture entry points) before they were
  removed.
- Revert check: restoring the original `harness.config.json` fails 9 of the new
  tests.

## Measurements (CLI 13.0.0, real tree)

| gate                                  | before (origin/main)         | after (branch)               |
| ------------------------------------- | ---------------------------- | ---------------------------- |
| `check-deps`                          | pass, 468 modules, 13 layers | pass, 501 modules, 15 layers |
| check-arch circular-deps              | 0 (863 files)                | 0 (857 files)                |
| check-arch layer-violations           | 0 (468 modules)              | 0 (501 modules)              |
| check-arch complexity / coupling      | 39 / 0 (653 files)           | 39 / 0 (649 files)           |
| check-arch new / threshold violations | 0 / 12                       | 0 / 12 (same id sets)        |
| entropy (`cleanup --findings-json`)   | 140 (ceiling 145)            | 114 (ceiling 145)            |
| perf (`check-perf`)                   | 211 (ceiling 220)            | 211 (ceiling 220)            |

The module count is 33 higher, not 30: upstream counts every path a `**` layer
glob matches, directories included (`npm/src`, `reporters`, `reporters/ingest`).
The existing 468 carries the same inflation. The rehearsal asserts the per-plant
delta, which is exact.

The entropy drop is purely subtractive: `harness cleanup --json` before and
after differ by 6 files and 26 findings, every one under `test/fixtures/`, with
0 additions.

## Parked fork (human decision)

The entropy ratchet stays green (exit 0, delta -26) but asks for its ceiling to
be lowered: "findings are 31 under the baseline. Please lower maxFindings ... to
124". Per the run's stop rule, `.harness/entropy-baseline.json` is NOT edited
here and no label is applied. Before/after: measuredCount 140 to 114,
maxFindings 145 (ratchet suggests 124). The arch and perf baselines do not need
to move.

## Assumptions and defaults taken

- Layer names `npm-cli` / `npm-reporter`; reporters as the leaf (matches today's
  import graph and the published `./reporter` export).
- `npm/scripts` and `npm/bin` are out of scope (the issue names `npm/src`;
  `bin/` is a default-skipped dir for the analyzers anyway).
- The live rehearsal is not wired into CI. Installing the harness CLI in
  `ts-validate` is a workflow change outside this issue.
- Upstream quirk, not filed: check-deps "modules" counts directories matched by
  `**`.
