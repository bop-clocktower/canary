# Nested test-config detection for `canary migrate` (#1212)

**Keywords:** framework-detection, probe-tiers, nested-config, bounded-walk,
workspace, abstention, migrate

## Overview

The config tier of framework detection (`probeConfig`,
`ts/src/core/framework-probes.ts:135`) checks `CONFIG_PROBES` file names only at
the probed directory. A package whose test configs sit below its root (the
reported shape: `Mobile/android/android-app/wdio.conf.ts`) gets no config-tier
hit. #1205 covered that reported case through the scripts and dependency tiers.
This change closes the remaining gap: the config tier itself cannot see nested
configs.

Goal: a single-package repo whose only evidence is a nested test config detects
that framework, and its evidence names the config's relative path. The change
must not regress the #504 monorepo detection, and two nested configs that
disagree must never be settled by walk order.

Out of scope: walking inside workspace packages, new framework vocabulary, and
any change to the per-package probe in `ts/src/core/workspace-detect.ts`.

## Decisions made

Settled by the human at the roadmap-fleet CONFIRM gate (this answers the
EVALUATE question):

1. **The walk runs only when no workspace is declared.** When
   `HarnessMigrator.detectFramework` (`ts/src/core/migrator.ts:2342`) has a
   non-null `WorkspaceInfo`, nothing is walked, so a package config can never be
   reported as a root hit. A workspace with zero matched packages still counts
   as declared, so it is not walked either.
2. **Depth ≤ 3, with an explicit skip list.** Matches can sit one to three
   directory levels below the root. Depth 0 is the existing root tier. The walk
   never enters `node_modules`, `.git`, or build/tool output: `dist`, `build`,
   `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `target`, `.venv`,
   `venv`, `__pycache__`. The list is an exported constant, and a test pins it.
3. **Agreement is on the (framework, shape) pair.** This matches
   `resolveFromWorkspace` (`ts/src/core/migrator.ts:2379`). If every nested hit
   agrees, the result is a hit with confidence `config` whose source names the
   first config's relative path, plus a count when there is more than one. If
   the hits disagree, the result is an explicit, terminal abstention
   `[null, 'unknown', 'nested configs (mixed: …)', 'none']`. No lower tier runs
   after it, so the language fallback cannot mask a disagreement.
4. **The unresolved-framework reason states what was probed**
   (`ts/src/core/migrator.ts:607`). For a single-package repo it reads "no
   config file at the root or up to 3 directories below it …". For a declared
   workspace it keeps "no root-level config file …", because nothing below a
   workspace root is walked. A mixed nested result gets its own reason, which
   names the disagreeing configs.

Decided in this brainstorm (autonomous lane, recorded as assumptions):

1. **Tier placement: directly after root `content`, before `scripts`.** The
   order is root config, then root content (pyproject, requirements,
   `scripts.test`), then nested config, then other scripts, then dependencies,
   then language. Root-level evidence describes the probed directory itself, so
   it keeps priority, as in #504 ("a root config file still outranks"). A nested
   config is stronger than other scripts, a dependency, or an inherited
   language. This avoids a regression where a repo with `test: vitest` and a
   nested `e2e/playwright.config.ts` would flip from vitest to playwright.
2. **Playwright refinement runs at the config's own directory.** It calls
   `inferPlaywrightTestType(configDir)`, because the specs sit next to the
   nested config and not at the root.
3. **Deterministic order.** Directory entries are sorted by code-point name at
   every level. Symlinked directories are not followed (`Dirent.isDirectory()`
   is false for links), which rules out cycles. An unreadable directory is
   skipped.

## Approaches considered

|      | A) New `nested-config` tier + walker module (chosen)                                                                                                                                 | B) Make `probeConfig` walk, with a flag to suppress it                                                                   | C) Walk post-hoc in the migrator after a root miss                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| How  | New `ProbeTier` value. A new module, `config-probes.ts`, owns the config-file tiers, including the walk and the agreement check. The migrator adds the tier only when `ws === null`. | `probeConfig(root, {walk})`, and every caller must opt out.                                                              | `detectFramework` walks when `rootProbe[0] === null`.                                                                                               |
| Pros | Callers opt in, so the per-package probe is untouched by construction. Fits the existing tier-list mechanism. Keeps `framework-probes.ts` (298/300 LOC) under the perf ceiling.      | Fewest new names.                                                                                                        | No change to the probe module.                                                                                                                      |
| Cons | One more tier name.                                                                                                                                                                  | Opt-out is the dangerous default: a forgotten flag walks every package. It also grows a file that is at the LOC ceiling. | The language tier already "hit" (typescript → playwright), so a root miss never happens in a TS repo. The walk would need language suppression too. |
| Risk | Low                                                                                                                                                                                  | Medium                                                                                                                   | High                                                                                                                                                |

**Recommendation: A.** The tier list in `probeFramework` already decides which
evidence each caller may use (`ts/src/core/framework-probes.ts:265-273`). The
walk fits that mechanism without a new one.

## Technical design

New module `ts/src/core/config-probes.ts`: everything the config-file tiers
read. `CONFIG_PROBES`, `inferPlaywrightTestType` and the root `probeConfig` move
here from `framework-probes.ts`, which keeps that file under the 300-LOC perf
ceiling and avoids an import cycle. The module then gains:

```ts
export const NESTED_CONFIG_MAX_DEPTH = 3;
export const NESTED_CONFIG_SKIP_DIRS: readonly string[];
/** Relative POSIX paths of every CONFIG_PROBES file 1..3 levels below root, sorted. */
export function findNestedConfigs(root: string): string[];
/** Hit, terminal mixed abstention, or null when nothing nested matched. */
export function probeNestedConfig(root: string): ProbeResult | null;
```

- `probeNestedConfig` maps each path to a (framework, shape). Playwright paths
  are refined at the config's directory. If one distinct pair results, it
  returns `[fw, shape, source, 'config']`, where source is `nested config <rel>`
  or `nested configs <rel> (+N more)`. Confidence is `content` when the
  Playwright refinement changed the shape, which mirrors the root tier. If more
  than one pair results, it returns
  `[null, 'unknown', 'nested configs (mixed: <rel> (fw/shape), …)', 'none']`.
- `framework-probes.ts`: `ProbeTier` gains `'nested-config'`. The steps list
  gains `['nested-config', () => probeNestedConfig(dir)]` after `content`. A
  step result whose framework is null and whose confidence is `none` stops the
  loop; this is how the mixed abstention ends detection. `CONFIG_PROBES` stays
  the single vocabulary.
- `migrator.ts`: `probeFramework` adds `'nested-config'` only when
  `ws === null`. `unresolvedFrameworkReason` takes the detection source, so a
  mixed nested result explains itself.

Import direction stays leafward:
`migrator -> workspace-detect -> framework-probes -> config-probes -> fs-glob`.
`workspace-detect` imports `CONFIG_PROBES` and `inferPlaywrightTestType` from
`config-probes` directly. There are no re-exports, so the dead-export check sees
real uses.

## Integration points

- **Entry Points:** none new. The behavior surfaces through `canary migrate` and
  `HarnessMigrator.detect`.
- **Registrations Required:** the new module is not an entry point. It needs an
  architecture layer binding (it sits under `ts/src/core/`, the same layer as
  `framework-probes.ts`), and its exports must have live importers so the
  dead-export check passes.
- **Documentation Updates:** the reason text in `migrator.ts`. Any doc that
  describes probe tiers (checked with `grep` during execution).
- **Architectural Decisions:** none. This is a small change inside an existing
  tier mechanism.
- **Knowledge Impact:** a new probe tier, `nested-config`, which only
  single-package roots use.

## Success criteria

1. When a single-package repo has only `Mobile/android/android-app/wdio.conf.ts`
   (no scripts, no deps), detection shall return `wdio`/`mobile` with confidence
   `config`, and the source shall contain
   `Mobile/android/android-app/wdio.conf.ts`.
2. When a workspace is declared, the system shall not report a package config as
   a root hit. This is a regression test against the
   `migrator-monorepo-report.test.ts` fixture: the source stays `workspace (…)`
   or `workspace (mixed)`.
3. A config at depth 4 shall not be found. A config under any
   `NESTED_CONFIG_SKIP_DIRS` entry, including `node_modules`, shall not be
   found. The skip list shall equal the documented list.
4. If nested configs disagree on (framework, shape), the system shall return
   framework null with a `nested configs (mixed: …)` source, whatever the walk
   order. That includes the case where `language: typescript` is configured.
5. When nothing matches in a single-package repo, the unresolved reason shall
   say the config tier looked up to 3 directories below the root. In a declared
   workspace it shall keep saying root-level.
6. Root `scripts.test` evidence shall still outrank a nested config.

## Implementation order

1. Extract `config-probes.ts` (pure move, existing tests green), then walker
   with the depth, skip, order and agreement logic (TDD on a temp tree).
2. Wire the `nested-config` tier into `probeFramework`, with mixed-abstention
   termination.
3. Migrator opt-in when `ws === null`, plus reason text, plus the monorepo
   regression test.
4. Gates and ratchets: perf LOC, entropy, arch, dead exports.
