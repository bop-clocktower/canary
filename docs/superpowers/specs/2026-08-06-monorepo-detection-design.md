# Monorepo-aware detection (#504 part 1)

**Status:** approved, not implemented **Issue:**
[#504](https://github.com/bop-clocktower/canary/issues/504) part 1 **Follows:**
[#585](https://github.com/bop-clocktower/canary/pull/585) (parts 2–4) **Date:**
2026-08-06

## Problem

`canary migrate` probes for a test framework at the repository root only. A
workspace repo whose test infrastructure lives in packages therefore reports:

```text
**Framework:** unknown
**Shape:** unknown

- Could not confidently auto-detect the test framework. Reason: no config file,
  dependency, or language marker matched a known framework.
```

The reported repo (Turborepo + pnpm workspaces) has a Playwright project in
`apps/web-e2e/` and Vitest/Jest configs in per-package files. Root
`scripts.test` is `turbo test`, which matches no probe.

**The cost is not the word "unknown".** `shape` selects which overlay skills
deploy (`deploy_to` frontmatter) and which workflow templates install
(`<shape>:` prefixes). An `unknown` shape therefore deploys only the
`deploy_to: ["all"]` subset and installs only unprefixed workflows. Canary's
largest consumer is a monorepo, so today the primary use case silently receives
canary's generic residue.

## The modeling error

A monorepo does not have an _unknown_ shape. It has **several, all true at
once** — `e2e_ui` in `apps/web-e2e`, `frontend_unit` in the packages. Forcing
that into one scalar is what produces `unknown`, and `unknown` is what
downgrades the deployment.

Abstaining _after_ finding Playwright in a package is not abstention — it is
discarding evidence. That is distinct from the no-silent-abstention doctrine
(#508), which governs the case where nothing was observed. Here something was
observed and then thrown away.

## Decisions

| Decision                                    | Choice                                                                                       | Rationale                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How far does monorepo awareness go?         | Detect and report per package; **act at the root**                                           | Workflows are inherently repo-level; per-package writes are a larger change with an unresolved rule for where workflows land                                                                                                                                                             |
| What do the scalar fields report?           | Root probe wins; else unanimous package value; else `unknown` **with `workspace` populated** | Preserves today's behavior exactly, never guesses, and turns a bare `unknown` into an explained abstention                                                                                                                                                                               |
| Does `shape` stay singular?                 | **No** — plural internally (`shapes`)                                                        | This is the change that pays: skills and workflows deploy for the union                                                                                                                                                                                                                  |
| Should canary suggest a monorepo structure? | **No.** Describe, never prescribe                                                            | Layout is dictated by turbo/pnpm/nx conventions and the team's decisions. Structural opinion is unverifiable preference dressed as a finding, and it contradicts the posture that makes canary credible. #585 already established the instinct by refusing to propose a duplicate suite. |

The one structural statement canary may make is a **measured** one: a package
with source and no test coverage anywhere. That belongs to
`canary-critical-areas`, not to `migrate`.

## Architecture

New module `ts/src/core/workspace-detect.ts`. `migrator.ts` is ~2,100 lines and
this is a distinct concern; it reuses `workspaceGlobs()` and `globDirs()`
shipped in #585.

```text
detectWorkspace(root, config) -> WorkspaceInfo | null
```

Returns `null` when no workspace file is declared. That null is the
back-compatibility guarantee: single-package repos never enter this code path.

`manager` is `pnpm` when `pnpm-workspace.yaml` exists, otherwise `npm`/`yarn`
from the package.json `workspaces` key. When both sources exist, `globs` is
their union (as `workspaceGlobs()` already does) and `manager` reports `pnpm`,
since that file is the one pnpm itself honours.

```ts
interface WorkspaceInfo {
  manager: 'pnpm' | 'npm' | 'yarn';
  globs: string[];
  scanned: number; // packages walked -- the denominator
  findings: WorkspaceFinding[]; // only packages where a probe actually hit
  unreadable: string[]; // package dirs that could not be read
}

interface WorkspaceFinding {
  dir: string; // relative to root, POSIX separators
  framework: string;
  shape: string;
  source: string; // e.g. "playwright.config.ts"
  confidence: string; // 'config' | 'content'
}
```

### The rule that decides correctness

Per-package probing uses the **config-file and content tiers only**. It must
never apply the `harness.config.json` language fallback.

Root probing today falls back to `language: typescript → playwright/e2e_ui`.
Applying that per package would make every package in a TypeScript monorepo
"detect" Playwright by inheritance — canary inventing findings it never
observed, in the exact shape this whole change exists to prevent. Root probing
keeps the fallback unchanged.

This requires splitting `probeFramework` so the fallback tier is opt-in, rather
than passing a package directory into the existing function.

## Contract

`MigrationContext` and `MigrationReport` each gain
`workspace: WorkspaceInfo | null` and `shapes: string[]`.

Scalar precedence, in order:

| Situation                               | `framework` / `shape`         | `detection_source`       |
| --------------------------------------- | ----------------------------- | ------------------------ |
| Root probe hits                         | root's answer (**unchanged**) | as today                 |
| Root misses; all package findings agree | the unanimous value           | `workspace (N packages)` |
| Root misses; packages disagree          | `unknown`                     | `workspace (mixed)`      |
| No workspace declared                   | **exactly today's behavior**  | as today                 |

"Agree" means agreement on the **`(framework, shape)` pair**, not on the
framework alone. Two Playwright packages that resolve to different shapes —
`e2e_ui` and `api`, via `inferPlaywrightShape` — are _not_ unanimous, because
the shape is what drives deployment and the two disagree about it.

An explicit `canary_shape` in `.canary/company.json` outranks all of the above,
unchanged from today.

`shapes` is the deduplicated, sorted union of the root shape (when known) and
every finding's shape. It is `[]` when nothing was detected.

### JSON surface

`migrate --json` gains `workspace`, `shapes`, and **`existing_suites`** — the
last closes a gap shipped in #585, where the field was added to the report but
never surfaced in JSON, leaving a scripted consumer with `would_create: []` and
no reason attached. That is the #582 abstention-without-reason shape.

## Deployment

`collectOverlaySkills` and the workflow selector take `shapes: string[]` instead
of `shape: string`, unioned and deduplicated by name. Deliberately one pass
rather than a loop over `deploySkills`, so the skill manifest is read and
written exactly once.

For the reported repo: `e2e_ui` **and** `frontend_unit` skills deploy, and both
workflow template sets install, where today it receives only the
`deploy_to: ["all"]` subset.

When `shapes` is empty, behavior is identical to today's `shape: 'unknown'`.

## Degradation — stated, never silent

| Case                                          | Behavior                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No workspace file                             | `workspace: null`; identical to today                                                                                                                                                                                                                            |
| Workspace file unparseable                    | detection proceeds with whatever globs _were_ readable — a broken `pnpm-workspace.yaml` does not discard a valid package.json `workspaces`. A `config_warning` names the unparseable file. With no readable globs at all, this is single-package behavior (#585) |
| Workspace declared, globs match 0 directories | reported: "declared N globs, matched 0 packages"                                                                                                                                                                                                                 |
| Packages matched, none carries a test config  | reported with the denominator: "pnpm workspace, 4 packages scanned, none carries a recognizable test config"                                                                                                                                                     |
| A package directory unreadable                | skipped, listed in `unreadable`, named in the report                                                                                                                                                                                                             |

The fourth row is the point: `scanned` is the denominator, so "found nothing"
can never again be indistinguishable from "did not look."

## Test plan

TDD throughout — every test written and failing before its implementation. Tests
extend `ts/test/migrator.test.ts` and add `ts/test/workspace-detect.test.ts`.

### Detection

| #   | Case                                                                                        | Assertion                                                            |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | pnpm workspace, playwright in one package                                                   | one finding, correct dir/framework/shape/source                      |
| 2   | npm `workspaces: []` array form                                                             | finding located                                                      |
| 3   | yarn `workspaces: {packages: []}` object form                                               | finding located                                                      |
| 4   | mixed: playwright + vitest packages                                                         | two findings; `shapes` = both, sorted                                |
| 5   | unanimous: three playwright packages                                                        | scalar `framework` = playwright, `source` = `workspace (3 packages)` |
| 6   | mixed packages                                                                              | scalar `framework` = `unknown`, `workspace` populated                |
| 7   | **language fallback must not leak** — TS `harness.config.json`, package with no test config | **zero findings** (the correctness guard)                            |
| 8   | root probe hits AND packages exist                                                          | root's answer wins, unchanged                                        |
| 9   | `canary_shape` set                                                                          | outranks workspace findings                                          |
| 10  | deep `**` workspace glob                                                                    | package located                                                      |
| 11  | `node_modules` inside a package                                                             | never a finding (#585 skip list)                                     |

### Degradation

| #   | Case                              | Assertion                                                  |
| --- | --------------------------------- | ---------------------------------------------------------- |
| 12  | no workspace file                 | `workspace === null`                                       |
| 13  | unparseable `pnpm-workspace.yaml` | single-package behavior + `config_warning` naming the file |
| 14  | globs match nothing               | `scanned === 0`, message states the glob count             |
| 15  | packages present, no configs      | message carries the scanned denominator                    |
| 16  | unreadable package dir            | listed in `unreadable`, named in report, no crash          |

### Deployment tests

| #   | Case                                                | Assertion                                           |
| --- | --------------------------------------------------- | --------------------------------------------------- |
| 17  | two shapes, overlay with shape-specific `deploy_to` | union deployed, deduped by name                     |
| 18  | same skill matches both shapes                      | deployed once                                       |
| 19  | `shapes: []`                                        | identical to today's `unknown`                      |
| 20  | workflows                                           | both `<shape>:` template sets install               |
| 21  | manifest                                            | read and written exactly once across a union deploy |

### Contract and regression

| #   | Case                                                                | Assertion                                                                                                                 |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 22  | **single-package repo: `to_markdown()` is byte-identical to today** | the back-compat guard. Scoped to the markdown deliberately — see below                                                    |
| 23  | `--json`                                                            | gains `workspace`, `shapes`, `existing_suites` **additively**; every field present today keeps its current name and value |
| 24  | MCP `migrateImpl`                                                   | for a single-package repo, returns the same `framework` value as before this change                                       |
| 25  | `--framework` override                                              | still resolves shape (#585), still outranked by `canary_shape`                                                            |

Test 22 is the markdown only. `--json` is _not_ byte-identical, by design: it
gains three keys. A single-package repo emits `workspace: null` and
`shapes: [<root shape>]`, which is additive and safe for existing consumers,
whereas the human-facing report must not change at all for repos this feature
does not concern.

Coverage: the repo's vitest coverage gate must stay green; `workspace-detect.ts`
is new code and is expected to land at or above the existing thresholds.

## Documentation plan

| Doc                                | Change                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/guides/migrate-detection.md` | **new.** Nothing documents the detection contract today: the tiers, the report format, scalar precedence, monorepo behavior, and the degradation table                                  |
| `docs/guides/tracked-overlays.md`  | shape→`deploy_to`→workflow chain becomes plural: L201 "matches the detected project shape", the **exit-3 abstention** wording at L248, and shape-prefixed workflow variants at L297–300 |
| `agents/skills/canary:migrate.md`  | `--framework` still says "Override auto-detected framework" — **already stale since #585**, which also resolves the shape; and skill deployment is described against a singular shape   |
| `docs/guides/company-knowledge.md` | `canary_shape` precedence now sits above workspace findings; state the full order                                                                                                       |
| `AGENTS.md`                        | detection paragraph, if it describes root-only probing                                                                                                                                  |
| `CHANGELOG.md`                     | Unreleased → Fixed                                                                                                                                                                      |

## Non-goals

- No `--package` flag and no per-package writes.
- No structural advice about how a monorepo should be laid out.
- `preserved_files` stays root-only.
- `turbo.json` is still not parsed: Turborepo declares tasks, not package
  locations, and defers to the pnpm/npm workspace file already read.
- Detection remains read-only.

## Known cost

This will trip the `module-size` arch ratchet again. The metric is a repo-wide
aggregate, so moving code into a new module does not reduce it — expect another
`--allow-regress` decision with a recorded reason. Complexity should **not** be
ratcheted; if a function exceeds the threshold, split it, as in #585.
