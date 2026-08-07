# Monorepo-aware detection

**Issue:** [#504](https://github.com/bop-clocktower/canary/issues/504) part 1
**Follows:** [#585](https://github.com/bop-clocktower/canary/pull/585) (parts
2–4) **Keywords:** monorepo, workspace-detection, pnpm-workspaces,
shape-resolution, overlay-skills, workflow-templates, abstention, evidence-tiers

## Overview and goals

`canary migrate` probes for a test framework at the repository root only. A
workspace repo whose test infrastructure lives in packages reports
`Framework: unknown` / `Shape: unknown` (`ts/src/core/migrator.ts:2022`,
`probeFramework` is root-anchored).

The cost is not the word "unknown". `shape` selects which overlay skills deploy
(`deploy_to` frontmatter, `migrator.ts:1689`) and which workflow templates
install (`<shape>:` prefixes, `docs/guides/tracked-overlays.md:297-300`). An
`unknown` shape therefore deploys only the `deploy_to: ["all"]` subset and
installs only unprefixed workflows. Canary's largest consumer is a monorepo, so
the primary use case receives canary's generic residue.

**Goal:** detection walks workspace packages and reports per-package findings;
shape becomes plural internally so skills and workflow templates deploy for the
union. Migration continues to act at the root.

### Strategy grounding

`STRATEGY.md#tracks` — "Adoption and onboarding: shorten the distance from
install to a first trustworthy gate." For a monorepo that distance is currently
unbounded. `STRATEGY.md#key-metrics` — "Time to first trustworthy gate" moves
directly. `STRATEGY.md#our-approach` — "degrades loudly when the evidence tier
drops rather than silently guessing" is the degradation contract below.

`STRATEGY.md#not-working-on` forbids company-specific content; this spec
describes the reporting repo by shape (Turborepo + pnpm workspaces) and never by
name.

## The modeling error

A monorepo does not have an _unknown_ shape. It has several, all true at once —
`e2e_ui` in an e2e package, `frontend_unit` in library packages. Forcing that
into one scalar produces `unknown`, and `unknown` downgrades the deployment.

Abstaining _after_ finding Playwright in a package is not abstention — it is
discarding evidence. That is distinct from the no-silent-abstention doctrine
(ADR 0009, #508), which governs the case where nothing was observed.

## Decisions made

| Decision                                    | Choice                                                                                       | Rationale                                                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How far does monorepo awareness go?         | Detect and report per package; **act at the root**                                           | Workflows are inherently repo-level; per-package writes need an unresolved rule for where workflows land                                                                                                                         |
| Scalar `framework`/`shape` for a monorepo   | Root probe wins; else unanimous package value; else `unknown` **with `workspace` populated** | Preserves today's behavior, never guesses, turns a bare `unknown` into an explained abstention                                                                                                                                   |
| Does unanimity apply at N=1?                | **Yes, N≥1**                                                                                 | The common "one e2e package" monorepo is unambiguous. `detection_source` reports `workspace (1 package)`, so the scalar never pretends a root probe hit. Root-scaffold duplication is already closed by #585's `existing_suites` |
| Does `shape` stay singular?                 | **No** — plural internally (`shapes`)                                                        | This is the change that pays: skills and workflow templates deploy for the union                                                                                                                                                 |
| Does `migrate --check` move to plural too?  | **Yes, in this change**                                                                      | `checkFreshness` (`migrator.ts:1941`) resolves the scalar. Leaving it behind means `--check` reports in-sync about skills it never examined — a deliberate false green in a drift gate                                           |
| Where does probe logic live?                | **Extract `ts/src/core/framework-probes.ts`**                                                | One source of truth for probes; leaves `migrator.ts` (2,165 lines) smaller. A duplicate package-probe would drift silently when a framework is added                                                                             |
| Should canary suggest a monorepo structure? | **No.** Describe, never prescribe                                                            | Layout is dictated by turbo/pnpm/nx conventions and the team's decisions. Structural opinion is unverifiable preference dressed as a finding. #585 established the instinct by refusing to propose a duplicate suite             |

The one structural statement canary may make is a measured one: a package with
source and no test coverage anywhere. That belongs to `canary-critical-areas`,
not `migrate`.

## Technical design

### Module layout

`ts/src/core/framework-probes.ts` — the probe tables (`_CONFIG_PROBES`,
`_PACKAGE_SCRIPT_PATTERNS`, `_PYTHON_DEP_PATTERNS`, `_PYPROJECT_MARKERS`,
`_LANGUAGE_FALLBACKS`, currently `migrator.ts:352-412`) plus a tiered probe:

```ts
type ProbeTier = 'config' | 'content' | 'language';
probe(dir: string, config: Record<string, unknown>, tiers: ProbeTier[]):
  [framework: string | null, shape: string, source: string, confidence: string];
```

`ts/src/core/workspace-detect.ts` — workspace topology and per-package probing.
Depends on `framework-probes.ts`, never on `migrator.ts`, so no core→core cycle.

```ts
detectWorkspace(root, config): WorkspaceInfo | null

interface WorkspaceInfo {
  manager: 'pnpm' | 'npm' | 'yarn';
  globs: string[];
  scanned: number;              // packages walked -- the denominator
  findings: WorkspaceFinding[]; // one per (package, framework) hit
  unreadable: string[];
}

interface WorkspaceFinding {
  dir: string;        // relative to root, POSIX separators
  framework: string;
  shape: string;
  source: string;     // e.g. "playwright.config.ts"
  confidence: 'config' | 'content';
}
```

`null` when no workspace file is declared. That null is the back-compatibility
guarantee: single-package repos never enter this path.

A package may produce **more than one finding**. A package carrying both
`playwright.config.ts` and `vitest.config.ts` is realistic, and since `shapes`
is a union, first-match-wins would silently drop a shape whose skills should
have deployed. `dir` is therefore not unique across `findings`, and
`findings.length` may exceed `scanned`. Warnings are reported through the
report's existing `config_warnings`; `WorkspaceInfo` does not carry its own
warning channel.

`manager` is `pnpm` when `pnpm-workspace.yaml` exists, else `npm`/`yarn` from
package.json `workspaces`. When both exist, `globs` is their union (as
`workspaceGlobs()` already does, `migrator.ts:589`) and `manager` reports
`pnpm`.

### The rule that decides correctness

Root probing calls `probe(root, config, ['config', 'content', 'language'])` —
unchanged behavior. Package probing calls
`probe(pkgDir, config, ['config', 'content'])`.

The language tier must never run per package. Root falls back to
`language: typescript → playwright/e2e_ui` (`_LANGUAGE_FALLBACKS`), so applying
it per package would make every package in a TypeScript monorepo "detect"
Playwright by inheritance — canary inventing findings it never observed, the
exact failure this change exists to prevent.

### Contract

`MigrationContext` and `MigrationReport` gain `workspace: WorkspaceInfo | null`
and `shapes: string[]`.

| Situation                             | `framework` / `shape`         | `detection_source`         |
| ------------------------------------- | ----------------------------- | -------------------------- |
| Root probe hits                       | root's answer (**unchanged**) | as today                   |
| Root misses; all findings agree (N≥1) | the unanimous value           | `workspace (N package[s])` |
| Root misses; findings disagree        | `unknown`                     | `workspace (mixed)`        |
| No workspace declared                 | **exactly today's behavior**  | as today                   |

"Agree" means agreement on the `(framework, shape)` pair, not the framework
alone: two Playwright packages resolving to `e2e_ui` and `api` via
`inferPlaywrightShape` are not unanimous, because shape drives deployment. Since
one package can yield multiple findings, a single package carrying both
Playwright and Vitest is itself non-unanimous and resolves the scalar to
`unknown` — while still contributing both shapes to `shapes`.

An explicit `canary_shape` in `.canary/company.json` outranks all of the above,
unchanged.

`shapes` is the deduplicated, sorted union of the root shape (when known) and
every finding's shape; `[]` when nothing was detected.

### Deployment

`collectOverlaySkills` and the workflow selector take `shapes: string[]`,
unioned and deduplicated by name — one pass, so the skill manifest is read and
written exactly once. `checkFreshness` resolves the same set, so `migrate` and
`--check` agree by construction. Empty `shapes` behaves identically to today's
`unknown`.

`--check --json` is documented at `docs/guides/tracked-overlays.md:258` as
`{ shape, overlay_path, in_sync, … }`. That published `shape` field **stays**,
carrying the same scalar the precedence table yields, and `shapes` is **added**
alongside it — additive, matching the `migrate --json` decision. No existing
consumer of that payload breaks.

### Degradation — stated, never silent

| Case                                     | Behavior                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No workspace file                        | `workspace: null`; identical to today                                                                                                                                                                                               |
| Workspace file unparseable               | detection proceeds with whatever globs were readable — a broken `pnpm-workspace.yaml` does not discard a valid package.json `workspaces`. A `config_warning` names the file. With no readable globs, single-package behavior (#585) |
| Globs match 0 directories                | reported: "declared N globs, matched 0 packages"                                                                                                                                                                                    |
| Packages matched, none has a test config | reported with denominator: "N packages scanned, none carries a recognizable test config"                                                                                                                                            |
| Package directory unreadable             | skipped, listed in `unreadable`, named in report                                                                                                                                                                                    |

`scanned` is the denominator, so "found nothing" is never indistinguishable from
"did not look".

### JSON surface

`migrate --json` gains `workspace`, `shapes`, and `existing_suites` — the last
closes a gap from #585, where the field was added to the report but never
surfaced in JSON, leaving a scripted consumer with `would_create: []` and no
reason attached (the #582 abstention-without-reason shape).

`--json` is additive: every field present today keeps its name and value.

## Integration Points

### Entry Points

- `canary migrate` — existing; gains `workspace`/`shapes` in report and `--json`
- `canary migrate --check` — existing; moves to plural shapes
- MCP `migrateImpl` (`ts/src/mcp-server.ts:568`) — unchanged fields, still
  returns the scalar `framework`
- New: `ts/src/core/framework-probes.ts`, `ts/src/core/workspace-detect.ts`

### Registrations Required

- No new CLI command or flag; nothing to register in `ts/src/cli.ts`
- Both new modules land in the `core` layer of the 9-layer role model
  (`harness.config.json:17`, 9 layers). `harness check-deps` must pass **run
  from the repo root**, and `workspace-detect → framework-probes` must not cycle
  back into `migrator`

### Documentation Updates

| Doc                                | Change                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/guides/migrate-detection.md` | **new** — nothing documents the detection contract today                                                                                                                                                                                                                           |
| `docs/guides/tracked-overlays.md`  | shape→`deploy_to`→workflow chain becomes plural: L201, the exit-3 abstention wording at L248, the `--check --json` payload at L258 (gains `shapes`), shape-prefixed variants at L297-300. This file is also where `canary_shape` is documented, so the precedence order lands here |
| `agents/skills/canary:migrate.md`  | `--framework` description — **stale since #585**, which also resolves shape; and singular shape in skill deployment                                                                                                                                                                |
| `AGENTS.md`                        | detection paragraph, if it describes root-only probing                                                                                                                                                                                                                             |
| `CHANGELOG.md`                     | Unreleased → Fixed                                                                                                                                                                                                                                                                 |

### Architectural Decisions

Two warrant standalone ADRs (next free: 0012):

- _Shape is plural_ — changes how overlay skills and workflow templates are
  selected, and sits directly on ADR 0009's exit-3 abstention semantics, which
  `tracked-overlays.md:248` documents in singular terms.
- _Canary describes monorepo topology, never prescribes it_ — a product-doctrine
  decision that will otherwise be re-litigated whenever someone asks whether
  canary should recommend a layout.

### Knowledge Impact

- Workspace topology as a first-class concept: manager, globs, packages,
  findings, scanned denominator.
- The distinction between _abstaining without evidence_ (ADR 0009) and
  _discarding evidence_ (this change) — they look identical in output today and
  have opposite correct responses.

## Success Criteria

1. When `migrate` runs in a repo declaring workspace packages, the system shall
   report each package's framework, shape, and evidence source.
2. When packages resolve to differing shapes, the system shall deploy overlay
   skills and workflow templates for the union of those shapes.
3. If a package carries no recognizable test config, the system shall not
   attribute a framework to it via the root language fallback.
4. When no workspace file is declared, `to_markdown()` shall be byte-identical
   to the pre-change output.
5. When a workspace is declared but no package carries a test config, the system
   shall report the count of packages scanned.
6. When `migrate --check` runs, the system shall resolve the same shape set that
   `migrate` deploys.
7. If a workspace file cannot be parsed, the system shall emit a config warning
   naming it and shall not discard globs from other readable sources.
8. When `migrate --apply` runs in a workspace repo, the system shall not write
   any file inside a workspace package directory.

## Assumptions

- **Runtime:** Node.js ≥ 20 with filesystem access; detection uses `readdirSync`
  and `readFileSync` (`ts/src/core/migrator.ts:432-503`).
- **Config source:** per-package probing is passed the **root**
  `harness.config.json`. A `harness.config.json` inside a package is not
  consulted — workspace packages are not independent harness projects, and the
  language tier is disabled for packages regardless.
- **Encoding:** workspace manifests are UTF-8.
- **Globs are root-relative**, matching `workspaceGlobs()` behavior shipped in
  #585.

## Test plan

TDD throughout — every test written and failing before its implementation. Tests
extend `ts/test/migrator.test.ts` and add `ts/test/workspace-detect.test.ts` and
`ts/test/framework-probes.test.ts`.

### Detection tests

| #   | Case                                                                                        | Assertion                                                           |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | pnpm workspace, playwright in one package                                                   | one finding: dir, framework, shape, source                          |
| 2   | npm `workspaces: []` array form                                                             | finding located                                                     |
| 3   | yarn `workspaces: {packages: []}` object form                                               | finding located                                                     |
| 4   | mixed playwright + vitest packages                                                          | two findings; `shapes` both, sorted                                 |
| 5   | unanimous, three playwright packages                                                        | scalar = playwright, source `workspace (3 packages)`                |
| 6   | unanimous at N=1                                                                            | scalar = that package's value, source `workspace (1 package)`       |
| 7   | mixed packages                                                                              | scalar `unknown`, `workspace` populated, source `workspace (mixed)` |
| 8   | **language fallback must not leak** — TS `harness.config.json`, package with no test config | **zero findings**                                                   |
| 9   | root probe hits AND packages exist                                                          | root's answer wins                                                  |
| 10  | `canary_shape` set                                                                          | outranks workspace findings                                         |
| 11  | deep `**` workspace glob                                                                    | package located                                                     |
| 12  | `node_modules` inside a package                                                             | never a finding (#585 skip list)                                    |
| 13  | two playwright packages, differing shapes                                                   | not unanimous → `unknown`                                           |
| 13a | one package with **both** `playwright.config.ts` and `vitest.config.ts`                     | **two findings for that dir**; `shapes` carries both                |
| 13b | same, scalar resolution                                                                     | non-unanimous → `unknown`, while both shapes still deploy           |

### Degradation tests

| #   | Case                                                             | Assertion                                               |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| 14  | no workspace file                                                | `workspace === null`                                    |
| 15  | unparseable `pnpm-workspace.yaml`, valid package.json workspaces | globs from package.json survive; warning names the yaml |
| 16  | unparseable, no other source                                     | single-package behavior + warning                       |
| 17  | globs match nothing                                              | `scanned === 0`, message states glob count              |
| 18  | packages present, no configs                                     | message carries the scanned denominator                 |
| 19  | unreadable package dir                                           | listed in `unreadable`, named in report, no crash       |

### Deployment tests

| #   | Case                                                | Assertion                                                                        |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| 20  | two shapes, overlay with shape-specific `deploy_to` | union deployed, deduped by name                                                  |
| 21  | same skill matches both shapes                      | deployed once                                                                    |
| 22  | `shapes: []`                                        | identical to today's `unknown`                                                   |
| 23  | workflows                                           | both `<shape>:` template sets install                                            |
| 24  | manifest                                            | read and written exactly once across a union deploy                              |
| 25  | `--check`                                           | resolves the same shape set `migrate` deploys                                    |
| 26  | `--check` exit 3                                    | still abstains when the union matches zero skills (ADR 0009)                     |
| 26a | `--check --json`                                    | keeps scalar `shape` **and** adds `shapes`; no documented key removed or renamed |

### Contract and regression

| #   | Case                                                    | Assertion                                                        |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 27  | **single-package repo: `to_markdown()` byte-identical** | back-compat guard                                                |
| 28  | `--json`                                                | gains `workspace`, `shapes`, `existing_suites` additively        |
| 29  | MCP `migrateImpl`                                       | single-package repo returns the same `framework` as before       |
| 30  | `--framework` override                                  | still resolves shape (#585), still outranked by `canary_shape`   |
| 31  | `framework-probes` extraction                           | root probe results unchanged across all existing detection tests |
| 32  | `--apply` in a workspace repo                           | **no file written inside any package directory** (criterion 8)   |

The vitest coverage gate must stay green; both new modules are expected to land
at or above existing thresholds.

## Implementation Order

| Phase | Content                                                               | Gate                                            |
| ----- | --------------------------------------------------------------------- | ----------------------------------------------- |
| 1     | Extract `framework-probes.ts`; `migrator` delegates                   | existing migrator tests + #27, #31 green        |
| 2     | `workspace-detect.ts` + `detectWorkspace()`                           | tests 1–13, incl. #8 fallback-leak guard        |
| 3     | Wire `workspace`/`shapes` into context + report; degradation messages | tests 14–19                                     |
| 4     | Plural deployment in skills, workflows, and `--check`                 | tests 20–26                                     |
| 5     | `--json` surface + docs + 2 ADRs                                      | tests 27–31, `markdownlint`, `check_doc_fences` |

Each phase is independently green — no phase leaves the tree failing.

## Non-goals

- No `--package` flag; no per-package writes.
- No structural advice about how a monorepo should be laid out.
- `preserved_files` stays root-only.
- `turbo.json` is still not parsed: Turborepo declares tasks, not package
  locations, and defers to the workspace file already read.
- Detection remains read-only.

## Known cost

This will trip the `module-size` arch ratchet. The metric is a repo-wide
aggregate, so moving code into new modules does not reduce it — expect an
`--allow-regress` decision with a recorded reason (the classifier blocks the
agent from running it; the human must). Complexity must **not** be ratcheted: if
a function exceeds the threshold, split it, as in #585.
