# Plan: Source-path-keyed collision abort for `installWorkflows`

**Date:** 2026-09-22 | **Spec:**
docs/changes/1008-migrator-basename-collision/proposal.md | **Tasks:** 8 |
**Time:** ~30 min | **Integration Tier:** small

## Goal

`HarnessMigrator.installWorkflows` aborts the whole migration with a plain
`Error` naming both source paths when two _different_ declared templates share a
`.github/workflows/` basename, while the _same_ source declared under two shapes
installs once, silently — replacing PR #1000's in-loop `claimed` map (keyed on
basename alone, which conflated the two cases and still suggested `--force`).

## Observable Truths (Acceptance Criteria)

1. When two different sources resolve to the same `.github/workflows/<name>`,
   `installWorkflows` throws an `Error` whose message names both source paths
   (with their declaring skill) and does not contain the string `--force`.
   [EARS: unwanted]
2. When the same source is declared under two shapes (or otherwise appears
   twice) and resolves to one basename, `installWorkflows` returns exactly one
   result row for that file and zero `conflict` rows. [EARS: event-driven]
3. For a fixed overlay/target pair, calling `installWorkflows` with
   `dryRun: true` and `dryRun: false` reach the same verdict: both throw in the
   collision case; both succeed with equivalent result rows in the dedupe case.
   [EARS: ubiquitous]
4. When `installWorkflows` throws because of a collision, nothing has been
   written under `.github/workflows/` in the target root. [EARS: unwanted]
5. `checkFreshness`, which calls `installWorkflows` in dry-run mode, also throws
   (does not swallow the abort) when the overlay it reads is collision-formed —
   inherited for free from truth 3, not a separate code path.
6. `npm run build`, `npm run typecheck`, `npm run format:check`, and `npm test`
   all pass from `ts/`.

## Uncertainties

- [ASSUMPTION] `checkFreshness` needs no code change — it already calls
  `installWorkflows(..., dryRun=true, force=false)` and a thrown `Error`
  propagates unchanged. No test is planned against `checkFreshness` directly;
  truth 5 is covered structurally by truth 3 plus code reading. If review
  disagrees, add a `checkFreshness` collision test as a follow-up — deferrable,
  does not change task decomposition below.
- [ASSUMPTION] The existing `describe('TestInstallWorkflowsBasenameCollision')`
  test (ts/test/migrator.test.ts:~3564) exercises exactly the "two different
  sources share a basename" scenario (`templates/api/guardian.yml` vs.
  `templates/e2e/guardian.yml`, different byte content), so under the new design
  it must be rewritten to assert a throw instead of asserting dry-run/apply
  result-array parity. This is a modification to an existing test, not a new one
  — called out explicitly in Task 1 so it isn't missed as "just adding cases."
- [DEFERRABLE] Exact wording of the abort message beyond the required elements
  (both source paths, declaring skills, rename remedy, no `--force`) is left to
  implementation-time judgment.

## File Map

- MODIFY `ts/test/migrator.test.ts` (rewrite one existing test, add four new
  tests, no new top-level helpers required — reuse `mkTmp`, `makeWorkflowSkill`,
  `mig`, `workflowPath`)
- MODIFY `ts/src/core/migrator.ts` (add one module-private helper function near
  `resolveTemplatePath`/`readWorkflowDeclaration`; remove the `claimed` map and
  its `conflict` branch from `installWorkflows`)

No new modules, no new exports, no new `entropy.entryPoints` declaration, no
arch-allowance bump — matches the spec's Integration Points section.

## Tasks

### Task 1: Rewrite the existing basename-collision test to assert an abort

**Depends on:** none | **Files:** `ts/test/migrator.test.ts`

The current test at `describe('TestInstallWorkflowsBasenameCollision')`
(~line 3564) declares `canary-pr-guardian` with two entries —
`api:templates/api/guardian.yml` (content `name: api\n`) and
`e2e_ui:templates/e2e/guardian.yml` (content `name: e2e\n`) — both resolving to
basename `guardian.yml`. These are two _different_ sources sharing a basename:
under the new design this is the collision case, not the dedupe-agreement case,
so the old assertions (`predicted`/`wrote` array parity,
`not.toContain('outdated')`) describe behavior that no longer exists and must be
replaced, not extended.

1. Replace the test body (keep the `describe` block and its preceding comment,
   update the comment's second sentence to describe the new behavior) with:

   ```ts
   describe('TestInstallWorkflowsBasenameCollision', () => {
     it('aborts when two different sources share a workflow filename', () => {
       const root = mkTmp();
       try {
         const overlay = join(root, 'overlay');
         makeWorkflowSkill(overlay, 'canary-pr-guardian', {
           install: [
             'api:templates/api/guardian.yml',
             'e2e_ui:templates/e2e/guardian.yml',
           ],
           templates: {
             'templates/api/guardian.yml': 'name: api\n',
             'templates/e2e/guardian.yml': 'name: e2e\n',
           },
         });
         const target = join(root, 'target');
         mkdirSync(target, { recursive: true });
         const shapes = ['api', 'e2e_ui'];

         expect(() =>
           mig().installWorkflows(shapes, overlay, target, false),
         ).toThrow(/guardian\.yml/);
         expect(existsSync(join(target, '.github', 'workflows'))).toBe(false);
       } finally {
         rmSync(root, { recursive: true, force: true });
       }
     });
   });
   ```

2. Do not run the suite yet — this test will fail (throw not yet implemented)
   until Task 6. That failure is expected TDD red; confirm it by running:
   `npx vitest run test/migrator.test.ts -t TestInstallWorkflowsBasenameCollision`
   from `ts/` and observing a failure (the old code returns a `conflict` row, it
   does not throw).
3. Do not commit yet — Task 1's red state is committed together with Tasks 2-5's
   red state in Task 5's commit, per this plan's TDD-then-implement split (see
   Task 5 step 3 and Task 6 step 1).

### Task 2: Add test — different sources name both paths, no `--force`

**Depends on:** Task 1 | **Files:** `ts/test/migrator.test.ts`

Add a new `it` inside the same
`describe('TestInstallWorkflowsBasenameCollision')` block, after the rewritten
test from Task 1:

```ts
it('names both source paths and never suggests --force', () => {
  const root = mkTmp();
  try {
    const overlay = join(root, 'overlay');
    makeWorkflowSkill(overlay, 'skill-a', {
      install: ['templates/a/shared.yml'],
      templates: { 'templates/a/shared.yml': 'name: a\n' },
    });
    makeWorkflowSkill(overlay, 'skill-b', {
      install: ['templates/b/shared.yml'],
      templates: { 'templates/b/shared.yml': 'name: b\n' },
    });
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });

    let thrown: Error | null = null;
    try {
      mig().installWorkflows(['all'], overlay, target, false);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    expect(message).toContain('templates/a/shared.yml');
    expect(message).toContain('templates/b/shared.yml');
    expect(message).not.toContain('--force');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Run: `npx vitest run test/migrator.test.ts -t "names both source paths"` from
`ts/` — expect failure (current code throws nothing; it pushes a `conflict` row
whose detail happens to omit `--force` today, but does not throw, so `thrown`
stays `null` and the first `expect` fails). Do not commit yet (see Task 5).

### Task 3: Add test — identical source under two shapes installs once, silently

**Depends on:** Task 2 | **Files:** `ts/test/migrator.test.ts`

Add a new `describe` block after `TestInstallWorkflowsBasenameCollision`:

```ts
describe('TestInstallWorkflowsIdenticalSourceDedupe', () => {
  it('installs once and reports no conflict when one source is declared under two shapes', () => {
    const root = mkTmp();
    try {
      const overlay = join(root, 'overlay');
      makeWorkflowSkill(overlay, 'canary-pr-guardian', {
        install: [
          'api:templates/guardian.yml',
          'e2e_ui:templates/guardian.yml',
        ],
        templates: { 'templates/guardian.yml': GUARDIAN_YML },
      });
      const target = join(root, 'target');
      mkdirSync(target, { recursive: true });
      const shapes = ['api', 'e2e_ui'];

      const results = mig().installWorkflows(shapes, overlay, target, false);

      expect(results.filter((r) => r.workflow === 'guardian.yml')).toHaveLength(
        1,
      );
      expect(results.map((r) => r.status)).not.toContain('conflict');
      expect(existsSync(workflowPath(target, 'guardian.yml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

`GUARDIAN_YML` is the existing module-level fixture constant
(`ts/test/migrator.test.ts:~2337`) — reuse it rather than inlining new content,
since both declared entries must resolve to byte-identical sources.

Run: `npx vitest run test/migrator.test.ts -t IdenticalSourceDedupe` from `ts/`
— expect pass already (today's `claimed` map already dedupes an exact repeat
basename+first-claimant path silently on the _second_ entry — verify this by
running the test before assuming it's red; if it unexpectedly passes under
current code, that is fine, it becomes a regression guard rather than
new-behavior red, and Task 6/7's refactor must keep it green). Do not commit yet
(see Task 5).

### Task 4: Add test — dry run and apply agree for collision and dedupe

**Depends on:** Task 3 | **Files:** `ts/test/migrator.test.ts`

Add a new `describe` block:

```ts
describe('TestInstallWorkflowsCollisionVerdictParity', () => {
  it('dry run and apply both throw for a collision', () => {
    const root = mkTmp();
    try {
      const overlay = join(root, 'overlay');
      makeWorkflowSkill(overlay, 'skill-a', {
        install: ['templates/a/shared.yml'],
        templates: { 'templates/a/shared.yml': 'name: a\n' },
      });
      makeWorkflowSkill(overlay, 'skill-b', {
        install: ['templates/b/shared.yml'],
        templates: { 'templates/b/shared.yml': 'name: b\n' },
      });
      const dryTarget = join(root, 'dry');
      const applyTarget = join(root, 'apply');
      mkdirSync(dryTarget, { recursive: true });
      mkdirSync(applyTarget, { recursive: true });

      expect(() =>
        mig().installWorkflows(['all'], overlay, dryTarget, true),
      ).toThrow();
      expect(() =>
        mig().installWorkflows(['all'], overlay, applyTarget, false),
      ).toThrow();
      expect(existsSync(join(dryTarget, '.github', 'workflows'))).toBe(false);
      expect(existsSync(join(applyTarget, '.github', 'workflows'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry run and apply agree in the identical-source dedupe case', () => {
    const root = mkTmp();
    try {
      const overlay = join(root, 'overlay');
      makeWorkflowSkill(overlay, 'canary-pr-guardian', {
        install: [
          'api:templates/guardian.yml',
          'e2e_ui:templates/guardian.yml',
        ],
        templates: { 'templates/guardian.yml': GUARDIAN_YML },
      });
      const dryTarget = join(root, 'dry');
      const applyTarget = join(root, 'apply');
      mkdirSync(dryTarget, { recursive: true });
      mkdirSync(applyTarget, { recursive: true });
      const shapes = ['api', 'e2e_ui'];

      const dry = mig().installWorkflows(shapes, overlay, dryTarget, true);
      const applied = mig().installWorkflows(
        shapes,
        overlay,
        applyTarget,
        false,
      );

      expect(dry.map((r) => r.status)).toEqual(['dry_run']);
      expect(applied.map((r) => r.status)).toEqual(['installed']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

Run: `npx vitest run test/migrator.test.ts -t CollisionVerdictParity` from `ts/`
— expect the first `it` to fail red (no throw today), the second to already pass
(dedupe-on-repeat already agrees under the current `claimed` map). Do not commit
yet (see Task 5).

### Task 5: Add test — nothing is written under `.github/workflows` on abort

**Depends on:** Task 4 | **Files:** `ts/test/migrator.test.ts`

This truth is already asserted inline in Tasks 1, 2, and 4 (each collision test
checks `existsSync(.../workflows)` is `false` after the throw). Add one more
explicit case that starts from a target which _already has_ an unrelated
installed workflow, to prove the abort does not touch pre-existing files either:

```ts
describe('TestInstallWorkflowsCollisionWritesNothing', () => {
  it('leaves a pre-existing workflow directory untouched when a later entry collides', () => {
    const root = mkTmp();
    try {
      const overlay = join(root, 'overlay');
      makeWorkflowSkill(overlay, 'skill-ok', {
        install: ['templates/ok.yml'],
        templates: { 'templates/ok.yml': 'name: ok\n' },
      });
      makeWorkflowSkill(overlay, 'skill-a', {
        install: ['templates/a/shared.yml'],
        templates: { 'templates/a/shared.yml': 'name: a\n' },
      });
      makeWorkflowSkill(overlay, 'skill-b', {
        install: ['templates/b/shared.yml'],
        templates: { 'templates/b/shared.yml': 'name: b\n' },
      });
      const target = join(root, 'target');
      mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        workflowPath(target, 'preexisting.yml'),
        'name: preexisting\n',
        'utf-8',
      );

      expect(() =>
        mig().installWorkflows(['all'], overlay, target, false),
      ).toThrow();

      expect(existsSync(workflowPath(target, 'preexisting.yml'))).toBe(true);
      expect(existsSync(workflowPath(target, 'ok.yml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

Run: `npx vitest run test/migrator.test.ts -t CollisionWritesNothing` from `ts/`
— expect red (current code writes `ok.yml` and reports `guardian.yml` — here
`shared.yml` — as `conflict` without throwing).

Once Tasks 1-5 are all in place, run the full file once to see the current
red/green split before touching implementation:
`npx vitest run test/migrator.test.ts` from `ts/`.

Commit (tests only, expected to be red for the collision assertions):

```bash
git add ts/test/migrator.test.ts
git commit -m "test(migrator): assert source-path-keyed collision abort (#1008)"
```

### Task 6: Add the module-private pre-pass collision helper

**Depends on:** Task 5 | **Files:** `ts/src/core/migrator.ts`

1. Add a new standalone (module-private, not a class method) function directly
   after `resolveTemplatePath` (~line 340, before the
   `export class WorkflowInstallResult` block at line 728 — keep it grouped with
   the other workflow-declaration helpers):

   ```ts
   /**
    * Refuses two DIFFERENT declared sources landing on one
    * `.github/workflows/<name>` before {@link HarnessMigrator.installWorkflows}
    * writes anything. The same source re-declared under a second shape (or
    * twice by mistake) is a legal no-op, not a collision (#1008): keying on
    * the resolved source path, not the basename, is what tells the two
    * cases apart.
    *
    * Entries that don't resolve (`invalid`) or aren't shipped (`missing`)
    * are silently ignored here -- the install loop still reports those
    * per-entry, this pre-pass only cares about basenames that WOULD be
    * written.
    */
   function assertNoWorkflowCollision(
     skills: Array<[SkillInfo, string]>,
     shapes: string[],
   ): void {
     const claimed = new Map<string, { src: string; label: string }>();
     for (const [info, skillDir] of skills) {
       const { entries } = readWorkflowDeclaration(info.path);
       for (const entry of entries) {
         const [wantShape, rel] = parseWorkflowEntry(entry);
         if (
           wantShape !== null &&
           !shapes.includes(wantShape) &&
           wantShape !== 'all'
         ) {
           continue;
         }
         const src = resolveTemplatePath(skillDir, rel);
         if (src === null || !isFile(src)) continue;
         const name = basename(src);
         const label = `'${rel}' (${info.name})`;
         const prior = claimed.get(name);
         if (prior === undefined) {
           claimed.set(name, { src, label });
           continue;
         }
         if (prior.src === src) continue;
         throw new Error(
           `.github/workflows/${name} would be installed from two ` +
             `different sources: ${prior.label} and ${label} ${EMDASH} ` +
             'there is no correct file to install; rename one template. ' +
             '(--force does not resolve a filename collision.)',
         );
       }
     }
   }
   ```

   Confirm `EMDASH`, `SkillInfo`, `isFile`, `basename` are already imported in
   this file (they are — `EMDASH` and `isFile` are used a few lines below in
   `installWorkflows` today, `SkillInfo` is `collectOverlaySkills`'s return
   type).

2. Call it at the top of `installWorkflows`, immediately after
   `const skills = this.collectOverlaySkills(shapes, overlayPath);` and before
   `const targetSkillsDir = ...`:

   ```ts
   const skills = this.collectOverlaySkills(shapes, overlayPath);
   assertNoWorkflowCollision(skills, shapes);
   const targetSkillsDir = join(targetRoot, '.canary', 'skills');
   ```

3. Run: `cd ts && npx tsc --noEmit` (or `npm run typecheck`) to confirm the new
   function type-checks before running tests.

### Task 7: Remove the in-loop `claimed` map and its `conflict` branch

**Depends on:** Task 6 | **Files:** `ts/src/core/migrator.ts`

1. Delete the `claimed` map declaration and its preceding comment (~lines
   1877-1880):

   ```ts
   // Destination filename -> the declaration that claimed it this run. Two
   // templates sharing a basename land on ONE file; without this the dry run
   // promised both installs while --apply wrote the first and misreported the
   // second against the first's fresh manifest entry.
   const claimed = new Map<string, string>();
   ```

   Replace with a plain `Set<string>` of basenames already installed this run,
   used only to make the (now pre-proven-safe) duplicate-declaration case a
   silent no-op:

   ```ts
   // Basenames already installed this run. assertNoWorkflowCollision has
   // already proven any repeat is the SAME source, so a repeat here is a
   // legal no-op declaration (e.g. the same template under two shapes) --
   // skip it silently rather than reprocessing it (#1008).
   const installedNames = new Set<string>();
   ```

2. Replace the conflict-detection block (~lines 1921-1932):

   ```ts
   const claimant = claimed.get(name);
   if (claimant !== undefined) {
     results.push(
       new WorkflowInstallResult(
         name,
         info.name,
         'conflict',
         `'${rel}' and ${claimant} both install .github/workflows/${name} ` +
           `${EMDASH} only the first was considered; rename one template`,
       ),
     );
     continue;
   }
   claimed.set(name, `'${rel}' (${info.name})`);
   ```

   with:

   ```ts
   if (installedNames.has(name)) continue;
   installedNames.add(name);
   ```

3. Confirm no other reference to `claimed` remains in the method:
   `grep -n "claimed" ts/src/core/migrator.ts` from the repo root should show
   zero hits after this edit (the identifier is fully retired, not renamed
   elsewhere).
4. Run: `npm run typecheck` from `ts/`.

### Task 8: Run tests green, then all four gates

**Depends on:** Task 7 | **Files:** none (verification only)

1. `cd ts && npx vitest run test/migrator.test.ts` — every test added in Tasks
   1-5 must now pass; no pre-existing test in this file may regress.
2. `cd ts && npm run build`
3. `cd ts && npm run typecheck`
4. `cd ts && npm run format:check` (run
   `npx prettier --write src/core/migrator.ts test/migrator.test.ts` first if
   this fails, then re-run `format:check`)
5. `cd ts && npm test` (full suite — confirms no unrelated regression, e.g. in
   `checkFreshness` tests that exercise `installWorkflows` indirectly)
6. Commit:

   ```bash
   git add ts/src/core/migrator.ts
   git commit -m "fix(migrator): abort on a basename collision keyed by source path (#1008)"
   ```

## Verification

Four gates, run from `ts/` (there is no `lint` script — do not invent one):

1. `npm run build`
2. `npm run typecheck`
3. `npm run format:check`
4. `npm test`

All four must be green on the final diff before this is considered done. No new
module, no new export, no new `entropy.entryPoints` entry, and no arch-allowance
change are expected or permitted by this plan.
