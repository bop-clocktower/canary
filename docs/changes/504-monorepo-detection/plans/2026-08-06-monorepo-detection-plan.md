# Plan: Monorepo-aware detection — Milestone 1 (detection)

**Date:** 2026-08-06 | **Spec:** [`../proposal.md`](../proposal.md) | **Tasks:**
16 | **Time:** ~65 min | **Integration Tier:** large

Covers spec **phases 1–3**. Phases 4–5 (plural deployment, `--json`, docs, ADRs)
are a separate plan — see [Milestone boundary](#milestone-boundary).

## Goal

`canary migrate` walks declared workspace packages and reports each package's
framework, shape, and evidence source with a scanned denominator — while
producing byte-identical output for every single-package repo.

## Observable Truths (Acceptance Criteria)

Adopted from the spec's Success Criteria; this milestone delivers 1, 3, 4, 5,
and 7. Criteria 2, 6, and 8 belong to Milestone 2.

1. When `migrate` runs in a repo declaring workspace packages, the system shall
   report each package's framework, shape, and evidence source.
2. If a package carries no recognizable test config, the system shall not
   attribute a framework to it via the root language fallback.
3. When no workspace file is declared, `to_markdown()` shall be byte-identical
   to the pre-change output.
4. When a workspace is declared but no package carries a test config, the system
   shall report the count of packages scanned.
5. If a workspace file cannot be parsed, the system shall emit a config warning
   naming it and shall not discard globs from other readable sources.

   Additionally (contract guards, spec tests 27 and 31):

   - Every existing `migrator.test.ts` case passes unchanged after the probe
     extraction.
   - `harness check-deps`, run **from the repo root**, reports no cycle.

## Plan-level decision — a third module

The spec names two new modules. It also requires
`workspace-detect → framework-probes` never to cycle back into `migrator`. Those
two constraints conflict: the config tier calls `inferPlaywrightShape`, which
calls `globFiles`, `readFileSync`-wrapping `readTextOrNull`, and `isFile` — all
currently private to `migrator.ts` (`:432-503`). Importing them from `migrator`
creates the cycle; duplicating them is the silent-drift failure the extraction
exists to prevent.

**Resolution:** a dependency-free leaf module `ts/src/core/fs-glob.ts` holding
the filesystem and glob helpers verbatim. Final chain:

```text
migrator.ts -> workspace-detect.ts -> framework-probes.ts -> fs-glob.ts
```

This is additive to the spec, not a contradiction of it, and is the smallest
change that satisfies the stated no-cycle rule. **Approved by the human before
execution** (recorded here as a planning decision, not an execution-time
improvisation).

## File Map

```text
CREATE ts/src/core/fs-glob.ts
CREATE ts/test/fs-glob.test.ts
CREATE ts/src/core/framework-probes.ts
CREATE ts/test/framework-probes.test.ts
CREATE ts/src/core/workspace-detect.ts
CREATE ts/test/workspace-detect.test.ts
MODIFY ts/src/core/migrator.ts   (delete moved helpers; import; delegate; wire)
MODIFY ts/test/migrator.test.ts  (context/report wiring + byte-identical guard)
MODIFY CHANGELOG.md              (Unreleased -> Fixed)
```

No file outside `ts/` and `CHANGELOG.md` is touched in this milestone. Docs and
ADRs land in Milestone 2, where the user-visible behavior actually changes.

## Skeleton

1. Extract `fs-glob.ts` and `framework-probes.ts` (~5 tasks, ~20 min)
2. `workspace-detect.ts` topology and per-package probing (~6 tasks, ~25 min)
3. Wire `workspace` / `shapes` into context, report, degradation (~5 tasks, ~20
   min)

_Skeleton approved: yes (option B, 2026-08-06)._

---

## Tasks

### Task 1: RED — direct tests for the glob helpers

**Depends on:** none | **Files:** `ts/test/fs-glob.test.ts`

These helpers are exercised only indirectly today. Making them a public module
means they need direct coverage before they move.

1. Create `ts/test/fs-glob.test.ts`:

   ```ts
   import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { describe, expect, it } from 'vitest';

   import { globDirs, globFiles, readTextOrNull } from '../src/core/fs-glob.js';

   function withTmp<T>(fn: (tmp: string) => T): T {
     const tmp = mkdtempSync(join(tmpdir(), 'canary-fsglob-'));
     try {
       return fn(tmp);
     } finally {
       rmSync(tmp, { recursive: true, force: true });
     }
   }

   describe('fs-glob', () => {
     it('matches files through a ** segment', () =>
       withTmp((tmp) => {
         mkdirSync(join(tmp, 'tests', 'deep'), { recursive: true });
         writeFileSync(join(tmp, 'tests', 'deep', 'a.spec.ts'), '');
         expect(globFiles(tmp, 'tests/**/*.spec.ts')).toHaveLength(1);
       }));

     it('never descends into node_modules when matching directories', () =>
       withTmp((tmp) => {
         mkdirSync(join(tmp, 'apps', 'web'), { recursive: true });
         mkdirSync(join(tmp, 'node_modules', 'pkg'), { recursive: true });
         expect(globDirs(tmp, '*/*')).toEqual([join(tmp, 'apps', 'web')]);
       }));

     it('returns null for an unreadable path', () =>
       withTmp((tmp) => {
         expect(readTextOrNull(join(tmp, 'nope.txt'))).toBeNull();
       }));
   });
   ```

2. Run: `cd ts && npx vitest run test/fs-glob.test.ts` — **observe failure**
   (module does not exist).
3. Commit: `test(core): cover glob helpers ahead of extraction`

### Task 2: Extract `fs-glob.ts`

**Depends on:** Task 1 | **Files:** `ts/src/core/fs-glob.ts`,
`ts/src/core/migrator.ts`

1. Create `ts/src/core/fs-glob.ts`. Move, **verbatim and with their existing doc
   comments**, from `migrator.ts`: `isDir`, `isFile`, `segGlobRegex`,
   `globFiles`, `subDirs`, `globDirs`, `_WORKSPACE_SKIP_DIRS`, `readTextOrNull`,
   `parseJsonOrNull`. Export every one of them. Header:

   ```ts
   /**
    * Filesystem and glob helpers shared by the migrator, the framework probes,
    * and workspace detection.
    *
    * A leaf module by design: it imports nothing from `core/`, which is what lets
    * `framework-probes` use `globFiles` without cycling back through `migrator`
    * (#504 part 1). The glob subset mirrors `Path.glob` -- `**` matches zero or
    * more directories, `*` matches within one segment.
    */
   ```

2. In `migrator.ts`, delete those definitions and add to the import block:

   ```ts
   import {
     _WORKSPACE_SKIP_DIRS,
     globDirs,
     globFiles,
     isDir,
     isFile,
     parseJsonOrNull,
     readTextOrNull,
   } from './fs-glob.js';
   ```

   Drop any now-unused `node:fs` imports the linter flags.

3. Run: `cd ts && npx vitest run test/fs-glob.test.ts` — **observe pass**.
4. Run: `cd ts && npx vitest run test/migrator.test.ts` — **observe pass,
   unchanged count**.
5. Run: `harness validate`
6. Commit: `refactor(core): extract fs-glob helpers from migrator (#504)`

### Task 3: RED — tiered probe tests, including the fallback-leak guard

**Depends on:** Task 2 | **Files:** `ts/test/framework-probes.test.ts`

Spec test **#8** is the one that decides correctness: the language tier must
never run per package.

1. Create `ts/test/framework-probes.test.ts`:

   ```ts
   import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { describe, expect, it } from 'vitest';

   import { probe } from '../src/core/framework-probes.js';

   function withTmp<T>(fn: (tmp: string) => T): T {
     const tmp = mkdtempSync(join(tmpdir(), 'canary-probe-'));
     try {
       return fn(tmp);
     } finally {
       rmSync(tmp, { recursive: true, force: true });
     }
   }

   const ALL = ['config', 'content', 'language'] as const;
   const PKG = ['config', 'content'] as const;

   describe('probe', () => {
     it('hits the config tier and reports the filename as the source', () =>
       withTmp((tmp) => {
         writeFileSync(join(tmp, 'playwright.config.ts'), '');
         expect(probe(tmp, {}, [...ALL])).toEqual([
           'playwright',
           'e2e_ui',
           'playwright.config.ts',
           'config',
         ]);
       }));

     it('applies the language fallback when the language tier is enabled', () =>
       withTmp((tmp) => {
         expect(probe(tmp, { language: 'typescript' }, [...ALL])).toEqual([
           'playwright',
           'e2e_ui',
           'harness.config.json (language: typescript)',
           'language',
         ]);
       }));

     // Spec test #8 -- the leak guard. Without the tier gate, every package in a
     // TypeScript monorepo would "detect" playwright by inheritance.
     it('never applies the language fallback without the language tier', () =>
       withTmp((tmp) => {
         expect(probe(tmp, { language: 'typescript' }, [...PKG])).toEqual([
           null,
           'unknown',
           'none',
           'none',
         ]);
       }));

     it('refines playwright to api when no spec uses page/browser fixtures', () =>
       withTmp((tmp) => {
         writeFileSync(join(tmp, 'playwright.config.ts'), '');
         mkdirSync(join(tmp, 'tests'), { recursive: true });
         writeFileSync(
           join(tmp, 'tests', 'a.spec.ts'),
           'test("x", async ({ request }) => {});',
         );
         expect(probe(tmp, {}, [...PKG])[1]).toBe('api');
       }));
   });
   ```

   Add `mkdirSync` to the `node:fs` import.

2. Run: `cd ts && npx vitest run test/framework-probes.test.ts` — **observe
   failure**.
3. Commit: `test(core): tier-gated probe tests incl. fallback-leak guard (#504)`

### Task 4: Extract `framework-probes.ts` and delegate

**Depends on:** Task 3 | **Files:** `ts/src/core/framework-probes.ts`,
`ts/src/core/migrator.ts`

1. Create `ts/src/core/framework-probes.ts`. Move verbatim from `migrator.ts`:
   `_CONFIG_PROBES`, `_PYPROJECT_MARKERS`, `_PACKAGE_SCRIPT_PATTERNS`,
   `_PYTHON_DEP_PATTERNS`, `_LANGUAGE_FALLBACKS`, `_PW_UI_FIXTURE_RE`,
   `inferPlaywrightShape`. Export `_CONFIG_PROBES` and `inferPlaywrightShape`
   (both are used by `migrator`'s `findWorkspaceSuites` and
   `shapeForFrameworkOverride`). **Preserve the `_PYTHON_DEP_PATTERNS` regex
   comment** — it documents the Python `re.MULTILINE` nuance and is
   load-bearing.

2. Add the tiered probe. Body is `probeFramework`'s five steps verbatim, each
   wrapped in its tier gate:

   ```ts
   export type ProbeTier = 'config' | 'content' | 'language';

   export type ProbeResult = [
     framework: string | null,
     shape: string,
     source: string,
     confidence: string,
   ];

   /**
    * Detect a test framework under *dir*, running only the requested *tiers*.
    *
    * The tier list is the whole point of this function. Root detection passes all
    * three; per-package detection passes `['config', 'content']` ONLY. The
    * language tier maps `language: typescript` to playwright/e2e_ui, so running it
    * per package would make every package in a TypeScript monorepo "detect"
    * playwright by inheritance -- canary inventing findings it never observed
    * (#504 part 1, spec test #8).
    *
    * Note the tier list and the returned `confidence` are not the same axis: the
    * config tier returns confidence `content` when `inferPlaywrightShape` refines
    * e2e_ui to api, because the refinement read file contents to decide.
    */
   export function probe(
     dir: string,
     config: Record<string, unknown>,
     tiers: ProbeTier[],
   ): ProbeResult {
     const on = (t: ProbeTier): boolean => tiers.includes(t);
     if (on('config')) {
       /* step 1 -- _CONFIG_PROBES, verbatim from probeFramework */
     }
     if (on('content')) {
       /* steps 2-4 -- pyproject, requirements*.txt, package.json scripts */
     }
     if (on('language')) {
       /* step 5 -- _LANGUAGE_FALLBACKS */
     }
     return [null, 'unknown', 'none', 'none'];
   }
   ```

3. In `migrator.ts`, replace the whole body of `private probeFramework` with:

   ```ts
     private probeFramework(
       root: string,
       config: Record<string, unknown>,
     ): ProbeResult {
       return probe(root, config, ['config', 'content', 'language']);
     }
   ```

   and import `probe`, `ProbeResult`, `_CONFIG_PROBES`, `inferPlaywrightShape`
   from `./framework-probes.js`.

4. Run: `cd ts && npx vitest run test/framework-probes.test.ts` — **observe
   pass**.
5. Commit: `refactor(core): extract tiered framework probes (#504)`

### Task 5: Verify the extraction changed nothing

**Depends on:** Task 4 | **Files:** none (verification only)

Spec tests **#27** and **#31**. This is the task that earns the right to build
on the extraction.

1. Run: `cd ts && npm test` — every pre-existing case passes; **record the test
   count and compare it to `2133`** (the count at `3fecfdf8`). A drop is a
   finding, not a rounding error.
2. Run: `cd ts && npm run build && npm run typecheck && npm run lint`
3. Run **from the repo root** (not `ts/`): `harness check-deps` — confirm
   `migrator -> workspace-detect -> framework-probes -> fs-glob` is acyclic and
   no layer boundary is crossed.
4. Run: `harness validate`
5. Commit: nothing (no source change). If any gate fails, fix it here rather
   than carrying it into Phase 2.

### Task 6: RED — workspace topology tests

**Depends on:** Task 5 | **Files:** `ts/test/workspace-detect.test.ts`

Spec tests **1, 2, 3**.

1. Create `ts/test/workspace-detect.test.ts` following `migrator.test.ts`'s
   `withTmp` / `write` idiom (`ts/test/migrator.test.ts:38-60`). Cases:
   - pnpm: `pnpm-workspace.yaml` with `packages:\n  - "apps/*"\n`, a package at
     `apps/web/playwright.config.ts` → `manager === 'pnpm'`,
     `globs === ['apps/*']`, `scanned === 1`, and one finding whose fields are
     `dir: 'apps/web'`, `framework: 'playwright'`, `shape: 'e2e_ui'`,
     `source: 'playwright.config.ts'`, `confidence: 'config'`.
   - npm array form: `package.json` `{"workspaces": ["apps/*"]}` →
     `manager === 'npm'`, finding located.
   - yarn object form: `{"workspaces": {"packages": ["apps/*"]}}` → finding
     located.
2. Run: `cd ts && npx vitest run test/workspace-detect.test.ts` — **observe
   failure**.
3. Commit: `test(core): workspace topology detection (#504)`

### Task 7: `workspace-detect.ts` — topology and single-finding probing

**Depends on:** Task 6 | **Files:** `ts/src/core/workspace-detect.ts`,
`ts/src/core/migrator.ts`

1. Create `ts/src/core/workspace-detect.ts`. Move from `migrator.ts`:
   `workspaceGlobs`, `parsePnpmPackages`, `packageJsonWorkspaceGlobs` (export
   `workspaceGlobs`; `migrator`'s `findWorkspaceSuites` still needs it). Add the
   interfaces exactly as the spec declares them (`WorkspaceInfo`,
   `WorkspaceFinding`) and:

   ```ts
   /**
    * Workspace topology and per-package findings, or `null` when no workspace
    * file is declared.
    *
    * That `null` is the back-compatibility guarantee: a single-package repo never
    * enters this path, so its report is byte-identical to the pre-change output
    * (#504 part 1, criterion 4).
    */
   export function detectWorkspace(
     root: string,
     config: Record<string, unknown>,
   ): WorkspaceInfo | null;
   ```

   Implementation outline (keep each function under the complexity threshold —
   split rather than ratchet, as in #585):

   - `workspaceGlobs(root)`; if empty **and** neither workspace file exists,
     return `null`.
   - `manager`: `'pnpm'` when `pnpm-workspace.yaml` exists, else
     `'npm'`/`'yarn'` from package.json.
   - dirs: union of `globDirs(root, glob)` per glob, deduped, sorted with
     `comparePathParts` (import from `migrator`? **no** — move
     `comparePathParts` into `fs-glob.ts` in this task and import it from there,
     so the direction stays leafward).
   - for each dir: `probe(dir, config, ['config', 'content'])`; push a finding
     when `framework !== null`. `dir` is
     `relative(root, d).split(sep).join('/')`.
   - `unreadable`: dirs whose `readdirSync` threw.

2. In `migrator.ts`, delete the moved functions and import `workspaceGlobs`,
   `detectWorkspace`, and the two interfaces from `./workspace-detect.js`.
3. Run:
   `cd ts && npx vitest run test/workspace-detect.test.ts test/migrator.test.ts`
   — **observe pass**.
4. Run: `harness validate`
5. Commit:
   `feat(core): detect workspace topology and per-package frameworks (#504)`

### Task 8: RED — a package may yield more than one finding

**Depends on:** Task 7 | **Files:** `ts/test/workspace-detect.test.ts`

Spec tests **4** and **13a**. First-match-wins would silently drop a shape whose
skills should have deployed — the exact failure this change exists to fix.

1. Add cases:
   - `apps/e2e/playwright.config.ts` + `apps/lib/vitest.config.ts` → two
     findings; the sorted union of shapes is `['e2e_ui', 'frontend_unit']`.
   - **one** package carrying both `playwright.config.ts` and `vitest.config.ts`
     → **two findings with the same `dir`**; `findings.length` (2) exceeds
     `scanned` (1).
2. Run: `cd ts && npx vitest run test/workspace-detect.test.ts` — **observe
   failure** (only one finding returned).
3. Commit: `test(core): a package can carry two frameworks (#504)`

### Task 9: Multi-finding probing

**Depends on:** Task 8 | **Files:** `ts/src/core/workspace-detect.ts`

1. Replace the single `probe()` call per directory with a loop that collects
   **every** `_CONFIG_PROBES` match in that directory, then falls back to the
   content tier only when the config tier produced nothing. Deduplicate on
   `(dir, framework, shape)`.
2. Add the doc comment stating why:

   ```ts
   // A package may carry both playwright.config.ts and vitest.config.ts. Since
   // `shapes` is a union that drives skill and workflow deployment,
   // first-match-wins would silently drop a shape whose skills should have
   // deployed -- so `dir` is NOT unique across findings, and findings.length may
   // exceed `scanned`.
   ```

3. Run: `cd ts && npx vitest run test/workspace-detect.test.ts` — **observe
   pass**.
4. Commit: `feat(core): collect every framework a package declares (#504)`

### Task 10: RED + GREEN — leak guard, node_modules, deep globs

**Depends on:** Task 9 | **Files:** `ts/test/workspace-detect.test.ts`,
`ts/src/core/workspace-detect.ts`

Spec tests **8, 11, 12**. Tests 11 and 12 should already pass from `globDirs`'s
`_WORKSPACE_SKIP_DIRS` (#585) — if they do, that is a regression guard, and the
task notes it rather than inventing a change.

1. Add cases: TypeScript `harness.config.json` + a package with **no** test
   config → `findings` is `[]` (test 8); `apps/**` deep glob locates a nested
   package (test 11); `node_modules` inside a package never yields a finding
   (test 12).
2. Run: `cd ts && npx vitest run test/workspace-detect.test.ts`. Record which
   cases were already green; implement only what is red.
3. Run: `harness validate`
4. Commit: `test(core): guard the language-fallback leak and skip dirs (#504)`

### Task 11: RED + GREEN — the scanned denominator and unreadable dirs

**Depends on:** Task 10 | **Files:** `ts/test/workspace-detect.test.ts`,
`ts/src/core/workspace-detect.ts`

Spec tests **17** and **19**. `scanned` is what makes "found nothing"
distinguishable from "did not look".

1. Add cases: globs matching zero directories → `scanned === 0` and
   `globs.length === 1`; a package directory whose `readdirSync` throws → listed
   in `unreadable`, no crash, still returns a `WorkspaceInfo`.

   Make the unreadable case deterministic with `chmod 0o000` guarded by
   `process.platform !== 'win32'` and `process.getuid?.() !== 0` — root ignores
   the mode bit, so an unguarded test silently passes for the wrong reason in a
   container.

2. Run: `cd ts && npx vitest run test/workspace-detect.test.ts` — red, then
   green.
3. Commit:
   `feat(core): report the scanned denominator and unreadable packages (#504)`

### Task 12: RED — scalar resolution from workspace findings

**Depends on:** Task 11 | **Files:** `ts/test/migrator.test.ts`

Spec tests **5, 6, 7, 9, 10, 13, 13b**. "Agree" means agreement on the
`(framework, shape)` **pair**, not the framework alone.

1. Add cases asserting `detect()`'s `detected_framework`, `detected_shape`, and
   `detection_source`:
   - three playwright packages, same shape → `playwright`, source
     `workspace (3 packages)` (test 5)
   - one package → source `workspace (1 package)`, **singular noun** (test 6)
   - playwright + vitest packages → `shape === 'unknown'`, source
     `workspace (mixed)` (test 7)
   - root probe hits **and** packages exist → root's answer wins, source
     unchanged (test 9)
   - `canary_shape` set → outranks workspace findings (test 10)
   - two playwright packages resolving to `e2e_ui` and `api` → **not** unanimous
     → `unknown` (test 13)
   - one package with playwright + vitest → scalar `unknown` while both shapes
     survive in `shapes` (test 13b)
2. Run: `cd ts && npx vitest run test/migrator.test.ts` — **observe failure**.
3. Commit: `test(migrator): workspace scalar resolution and precedence (#504)`

### Task 13: Resolve the scalar; preserve root and `canary_shape` precedence

**Depends on:** Task 12 | **Files:** `ts/src/core/migrator.ts`

1. In `detectFramework` (`migrator.ts:1999`), after `probeFramework` returns and
   **before** the `explicitShape` branch, add: when the root probe missed
   (`framework === null`) and `detectWorkspace` returned findings, resolve the
   scalar from them.
2. Add a private helper so `detectFramework` stays under the complexity
   threshold:

   ```ts
     /**
      * The scalar (framework, shape, source) implied by workspace findings.
      *
      * Unanimity is on the (framework, shape) PAIR, not the framework alone --
      * shape drives which overlay skills and workflow templates deploy, so two
      * playwright packages resolving to e2e_ui and api are not unanimous. Applies
      * at N >= 1: `detection_source` reports the package count, so the scalar
      * never pretends a root probe hit (#504 part 1).
      */
     private resolveFromWorkspace(ws: WorkspaceInfo): ProbeResult | null;
   ```

   Return `null` when `findings` is empty. Source string:
   `workspace (${n} package${n === 1 ? '' : 's'})` when unanimous, else
   `workspace (mixed)` with `[null, 'unknown', ..., 'none']`.

3. Confirm ordering: `canary_shape` still outranks the workspace result — the
   existing `explicitShape` branch must run **after** this resolution,
   unchanged.
4. Run: `cd ts && npx vitest run test/migrator.test.ts` — **observe pass**.
5. Run: `harness validate`
6. Commit:
   `feat(migrator): resolve framework and shape from workspace packages (#504)`

### Task 14: RED — degradation is stated, never silent

**Depends on:** Task 13 | **Files:** `ts/test/migrator.test.ts`

Spec tests **14, 15, 16**.

1. Add cases:
   - no workspace file → `workspace === null` (test 14)
   - **unparseable `pnpm-workspace.yaml` alongside a valid package.json
     `workspaces`** → globs from package.json survive, and a `config_warning`
     names `pnpm-workspace.yaml` (test 15). This is the one that matters: a
     broken yaml must not discard a readable second source.
   - unparseable yaml, no other source → single-package behavior (#585) plus the
     warning (test 16)
2. Run: `cd ts && npx vitest run test/migrator.test.ts` — **observe failure**.
3. Commit: `test(migrator): workspace degradation warnings (#504)`

### Task 15: Degradation warnings and the denominator message

**Depends on:** Task 14 | **Files:** `ts/src/core/workspace-detect.ts`,
`ts/src/core/migrator.ts`

Spec test **18**.

1. `parsePnpmPackages` returning `[]` for a file that **exists and is
   non-empty** is the unparseable signal. Surface it through the report's
   existing `config_warnings` channel — `WorkspaceInfo` carries no warning
   channel of its own (spec, Module layout). Have `detectWorkspace` return the
   warning strings alongside the info, or accept a `warnings: string[]` sink
   parameter; either way `migrator` appends them to `ctx.config_warnings`.
2. Add the denominator messages to `MigrationReport.to_markdown()`, emitted only
   when `workspace !== null`:
   - `globs.length > 0 && scanned === 0` →
     `declared N glob(s), matched 0 packages`
   - `scanned > 0 && findings.length === 0` →
     `N packages scanned, none carries a recognizable test config`
   - `unreadable.length > 0` → name each one
3. Run: `cd ts && npx vitest run test/migrator.test.ts` — **observe pass**.
4. Commit:
   `feat(migrator): state workspace degradation with its denominator (#504)`

### Task 16: Wire the contract; prove single-package output is unchanged

**Depends on:** Task 15 | **Files:** `ts/src/core/migrator.ts`,
`ts/test/migrator.test.ts`, `CHANGELOG.md`

Spec test **27** — criterion 4, the back-compat guard.

1. Add `workspace: WorkspaceInfo | null` and `shapes: string[]` to
   `MigrationContextInit`/`MigrationContext` (`:755`) and
   `MigrationReportInit`/`MigrationReport` (`:1087`), defaulting to `null` and
   `[]`. Populate both at the three `new MigrationReport({...})` sites (`:1580`,
   `:1604`, and the early-return path).
2. `shapes` = deduplicated, sorted union of the root shape (when not `unknown`)
   and every finding's shape; `[]` when nothing was detected.
3. Add the byte-identical guard to `ts/test/migrator.test.ts`:

   ```ts
   it('leaves single-package markdown byte-identical', () =>
     withTmp((tmp) => {
       // ...scaffold a plain non-workspace harness project...
       const report = mig().migrate(tmp, { dryRun: true });
       expect(report.workspace).toBeNull();
       expect(report.shapes).toEqual(['e2e_ui']);
       expect(report.to_markdown()).toBe(EXPECTED_SINGLE_PACKAGE_MARKDOWN);
     }));
   ```

   Capture `EXPECTED_SINGLE_PACKAGE_MARKDOWN` from a run at commit `3fecfdf8` —
   **not** from the post-change code, which would assert the bug into the
   baseline.

4. Add to `CHANGELOG.md` under `## [Unreleased]` → `### Fixed`: `- \`canary
   migrate\` now walks workspace packages and reports each package's framework,
   shape, and evidence source, with the count of packages scanned
   ([#504](https://github.com/bop-clocktower/canary/issues/504))`
5. `[checkpoint:human-action]` — **the `module-size` arch ratchet will trip.**
   The metric is a repo-wide aggregate, so moving code into new modules does not
   reduce it. The classifier blocks an agent from running `--allow-regress`; a
   human must run it and record the reason. Complexity must **not** be ratcheted
   — split any function over threshold, as in #585. Execution stops here until
   you have run it.
6. Run the four gates from `ts/`:
   `npm run build && npm run typecheck && npm run lint && npm test`, then
   `harness check-deps` **from the repo root**.
7. Run: `harness validate`
8. Commit:
   `feat(migrator): carry workspace topology and shapes on the report (#504)`

---

## Milestone boundary

Milestone 1 lands `workspace` and `shapes[]` with **no change to deployment
behavior**. `shapes` is populated and unread; every single-package repo produces
byte-identical output. That is deliberate: it makes this PR reviewable as
"detection got richer, nothing else moved."

**Milestone 2** (spec phases 4–5, ~12 tasks) covers:

| Work                                                    | Spec tests  |
| ------------------------------------------------------- | ----------- |
| `collectOverlaySkills` → plural                         | 20, 21, 22  |
| Workflow selector → plural                              | 23          |
| Manifest read/written exactly once                      | 24          |
| `checkFreshness` / `--check`                            | 25, 26, 26a |
| `--json` gains `workspace`, `shapes`, `existing_suites` | 28          |
| MCP `migrateImpl` unchanged                             | 29          |
| `--framework` override precedence                       | 30          |
| `--apply` writes nothing in a package dir               | 32          |
| 5 doc targets + ADRs 0012, 0013                         | —           |

It is **not** expanded here on purpose. Its tasks depend on the exact shape of
the `WorkspaceInfo` and `shapes[]` that Milestone 1 lands, and writing exact
code against types that do not exist yet would be fabricated precision. Run
`/harness:planning` again against this spec once Milestone 1 merges.

## Uncertainties

- **[ASSUMPTION]** `tiers: ['config', 'content']` includes
  `inferPlaywrightShape` — it sits inside the config-probe step but returns
  confidence `'content'` (`migrator.ts:2030-2035`). Task 3's fourth test pins
  this. If wrong, API-shaped playwright packages get labeled `e2e_ui` and the
  wrong skills deploy.
- **[ASSUMPTION]** `MigrationContext` has no `to_markdown()` — verified; the
  byte-identical guard applies to `MigrationReport.to_markdown()` (`:1155`)
  only. `FreshnessReport.to_markdown()` (`:973`) prints a scalar `**Shape:**`
  and is Milestone 2's problem.
- **[DEFERRABLE]** ADR numbers 0012 and 0013 — confirm neither is claimed by a
  peer branch before Milestone 2 writes them.
- **[DEFERRABLE]** Test-count baseline `2133` assumes no peer session has landed
  tests since `3fecfdf8`. Task 5 re-derives it rather than trusting this number.

## Known cost

The `module-size` arch ratchet trips (spec, Known cost). Confirmed against
`.harness/arch/baselines.json`: `module-size` is a **repo-wide aggregate**
currently at `26153` with 6 recorded violation ids, so relocating code into new
modules cannot reduce it — three new source files only add. `complexity` sits at
`88`; per the spec it must **not** be ratcheted, so any function over threshold
gets split (as in #585).

Note the baseline was last refreshed at `2026-08-06T19:00:03Z` from commit
`ca582505`, which is **not** an ancestor of this branch — a peer session touched
it. Re-derive rather than trust it (Task 5).
