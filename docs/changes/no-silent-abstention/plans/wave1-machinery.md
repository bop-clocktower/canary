# Plan: No Silent Abstention — Wave 1 (Machinery)

**Date:** 2026-07-30 | **Spec:** `docs/changes/no-silent-abstention/proposal.md`
| **Tasks:** 5 | **Time:** ~30 min | **Integration Tier:** medium | **Branch:**
`feat/abstention-wave1-machinery`

Wave 1 of 5 (spec Implementation Order item 1). This plan covers ONLY the
machinery wave: the shared helper, the conformance harness with its first two
registry rows, the retrofit of the shipped `migrate --check` gate (#510), and
the dry-run copy fix (#504's abstention half). Waves 2-5 are explicitly out of
scope and get their own plans.

## Goal

The ts engine has one shared abstention helper (`gate-result.ts`) and one
table-driven conformance suite; `migrate --check` (gate) and `migrate` dry-run
(advisory) are its first two registered, passing rows — with zero observable
behavior change to the freshness gate.

## Observable Truths (Acceptance Criteria)

1. The system shall export `EXIT_ABSTAINED = 3`, `GateResult<F>`, `SkipEntry`,
   and `gateOutcome` from `ts/src/core/gate-result.ts`.
2. When `gateOutcome(r, 'gate')` is called with `r.checked === 0`, it shall
   return `exitCode: 3`, `abstained: true`, and a summary line containing
   "Abstained" (D3/D4).
3. When `gateOutcome(r, 'advisory')` is called with `r.checked === 0`, it shall
   return `exitCode: 0`, `abstained: true`, and an unmissable warning line
   containing "Abstained" (D3).
4. While rendering any summary line, skipped entries shall always render as a
   `(N skipped: ...)` suffix and shall never add to the passed count (D7).
5. `FreshnessReport.exit_code()` and `FreshnessReport.abstained` shall delegate
   to `gateOutcome`/`EXIT_ABSTAINED`, and the existing migrator + migrate-CLI
   suites shall pass unchanged (byte-identical markdown, same exit codes, same
   JSON — spec success criterion 5).
6. When `canary migrate --check` runs against a harness project with unknown
   shape and an empty overlay, the CLI shall exit 3 with "Abstained" in stdout
   (registry row 1, already-shipped behavior now locked by the harness).
7. When `canary migrate` (dry run) would migrate zero items, the report shall
   print an advisory abstention line and shall NOT print "Migration complete"
   (registry row 2).
8. When `canary migrate` (dry run) would migrate N > 0 items, the Status section
   shall use "would migrate" phrasing (not "Migration complete"); apply-mode
   keeps "Migration complete." byte-for-byte.
9. `ts/test/gate-conformance.test.ts` shall exist with the row shape
   `{ command, layer, kind, fixture, expect }` and both seed rows passing — the
   table is the canonical gate registry (D5).
10. The full ts suite (1639 existing tests + new ones) and `npx tsc --noEmit`
    shall pass at the wave boundary (D6).

## Prior Decisions Honored

D1 (loud by default), D3 (gate exit 3 / advisory warn+0), D4 (exit 3 reserved
CLI-wide), D5 (conformance table = registry), D6 (wave 1 derisks the helper on
the already-shipped #510 gate), D7 (skipped never folds into passed). No new
flags, no new commands.

## Uncertainties

- [ASSUMPTION] `harness.config.json` with `language: 'unknown-lang'` yields
  `shape === 'unknown'` (evidence: `ts/test/migrator.test.ts:690` and `:1263`).
  If detection changes, row 1's fixture falls back to
  `{ language: 'python', layers: [] }` — still zero-denominator vs an empty
  overlay.
- [ASSUMPTION] No test outside `ts/test/migrator.test.ts` pins the dry-run
  "Migration complete." copy (verified by repo-wide grep: only
  `migrator.test.ts:723,730` (not-contains) and `:1639` (apply mode) touch it;
  `canary-cli-coverage2.test.ts:368` asserts only exit codes). If Task 4's full
  run flushes out another pin, update it to the new copy in the same commit.
- [ASSUMPTION] `gateOutcome`'s non-abstained exit mapping (findings > 0 → 1 for
  gates) is a helper default only; `FreshnessReport` keeps its surface-specific
  1-drift/2-local-edits mapping after the abstention check. The helper owns the
  abstention path in wave 1; broader exit unification is not in any wave.
- [DEFERRABLE] Exact remediation copy per surface (spec requires remediation
  text; wording below is the proposal, tweakable at review without replanning).

## File Map

- CREATE `ts/src/core/gate-result.ts`
- CREATE `ts/test/gate-result.test.ts`
- CREATE `ts/test/gate-conformance.test.ts`
- MODIFY `ts/src/core/migrator.ts` (FreshnessReport retrofit; MigrationReport
  dry-run Status + `would_migrate_count`)
- MODIFY `ts/test/migrator.test.ts` (EXIT_ABSTAINED coupling assert; new dry-run
  status describe block)

## Conventions (apply to every task)

- Run all commands from `/Users/bs/Github/canary/ts/`.
- TDD: write the test, watch it fail, implement, watch it pass.
- Source stays ASCII: output glyphs are `\u{...}` escapes (the `migrator.ts`
  header convention). `\u{26A0}` = warning sign, `\u{2014}` = em dash.
- Before each commit: `npx prettier --write <changed files>` then
  `npx tsc --noEmit`.
- Commit messages: conventional, no co-author trailers.

---

## Tasks

### Task 1: `gate-result.ts` — the shared abstention helper (TDD)

**Depends on:** none | **Files:** `ts/src/core/gate-result.ts`,
`ts/test/gate-result.test.ts`

1. Create `ts/test/gate-result.test.ts`:

   ```ts
   /**
    * Tests for the shared gate-abstention helper (#508, no-silent-abstention
    * D3/D4/D7): a check that verified zero items has abstained, not passed.
    */
   import { describe, expect, it } from 'vitest';

   import {
     EXIT_ABSTAINED,
     gateOutcome,
     GateResult,
   } from '../src/core/gate-result.js';

   const WARN = '\u{26A0}';

   function result<F>(
     checked: number,
     findings: F[] = [],
     skipped?: { name: string; reason: string }[],
   ): GateResult<F> {
     return { checked, findings, skipped };
   }

   describe('gate-result helper', () => {
     it('reserves exit 3 for abstained (D4)', () => {
       expect(EXIT_ABSTAINED).toBe(3);
     });

     it('gate + zero denominator abstains loudly with exit 3', () => {
       const o = gateOutcome(result(0), 'gate');
       expect(o.exitCode).toBe(EXIT_ABSTAINED);
       expect(o.abstained).toBe(true);
       expect(o.summaryLine.toLowerCase()).toContain('abstained');
       expect(o.summaryLine).toContain(WARN);
     });

     it('advisory + zero denominator warns unmissably but exits 0 (D3)', () => {
       const o = gateOutcome(result(0), 'advisory');
       expect(o.exitCode).toBe(0);
       expect(o.abstained).toBe(true);
       expect(o.summaryLine.toLowerCase()).toContain('abstained');
       expect(o.summaryLine).toContain(WARN);
     });

     it('gate with findings exits 1, not abstained', () => {
       const o = gateOutcome(result(3, ['finding']), 'gate');
       expect(o.exitCode).toBe(1);
       expect(o.abstained).toBe(false);
       expect(o.summaryLine).toContain('1 finding(s) across 3 checked');
     });

     it('advisory with findings still exits 0', () => {
       expect(gateOutcome(result(2, ['x']), 'advisory').exitCode).toBe(0);
     });

     it('clean pass says how many were run (D7 phrasing)', () => {
       const o = gateOutcome(result(4), 'gate');
       expect(o.exitCode).toBe(0);
       expect(o.abstained).toBe(false);
       expect(o.summaryLine).toContain('All 4 run check(s) passed');
     });

     it('skipped entries always render and never count as passed (D7)', () => {
       const skipped = [
         { name: 'mcp-probe', reason: 'no consent' },
         { name: 'net-check', reason: 'offline' },
       ];
       const clean = gateOutcome(result(4, [], skipped), 'gate');
       expect(clean.summaryLine).toContain('All 4 run check(s) passed');
       expect(clean.summaryLine).toContain('(2 skipped: mcp-probe, net-check)');
       // Skipped-everything is an abstention, not a pass.
       const allSkipped = gateOutcome(result(0, [], skipped), 'gate');
       expect(allSkipped.abstained).toBe(true);
       expect(allSkipped.exitCode).toBe(EXIT_ABSTAINED);
       expect(allSkipped.summaryLine).toContain('(2 skipped:');
       // Findings line carries the suffix too.
       const found = gateOutcome(result(3, ['f'], skipped), 'gate');
       expect(found.summaryLine).toContain('(2 skipped:');
     });
   });
   ```

2. Run and observe failure (module does not exist):
   `npx vitest run test/gate-result.test.ts`
3. Create `ts/src/core/gate-result.ts`:

   ```ts
   /**
    * Shared gate-abstention helper (issue #508, no-silent-abstention spec).
    *
    * Doctrine: a check that verified zero items has ABSTAINED, not passed.
    * Every gate reports its denominator (`checked`); zero is a distinct loud
    * outcome. "Skipped" renders in every summary line and never aggregates
    * into "passed" (D7).
    *
    * `gateOutcome` is the only path to a summary line for swept commands, so
    * the refusal to print bare success on a zero denominator is structural.
    * Surfaces append their own remediation text (why the denominator
    * collapsed, first fix step) after the summary line.
    *
    * Output glyphs are written as `\u{...}` escapes so this source stays
    * ASCII while the emitted bytes match the rest of the CLI (warning sign
    * U+26A0, em dash U+2014).
    */

   /** A check that was not run, and why. Always visible, never "passed". */
   export interface SkipEntry {
     name: string;
     reason: string;
   }

   /** What a gate actually verified: its denominator and what it found. */
   export interface GateResult<F> {
     /** How many items were actually verified. Skipped items do NOT count. */
     checked: number;
     findings: F[];
     skipped?: SkipEntry[];
   }

   /**
    * Reserved CLI-wide (D4): exit 3 always means "abstained -- verified zero
    * items", distinct from 0 (clean), 1 (findings), 2 (surface-specific).
    */
   export const EXIT_ABSTAINED = 3;

   /**
    * D3: a "gate" has an exit-code contract and fails loud (exit 3) on a zero
    * denominator; an "advisory" command warns unmissably but exits 0 -- an
    * empty answer honestly labeled is not an error.
    */
   export type GateKind = 'gate' | 'advisory';

   export interface GateOutcome {
     exitCode: number;
     abstained: boolean;
     summaryLine: string;
   }

   const WARN = '\u{26A0}'; // warning sign
   const EMDASH = '\u{2014}'; // em dash

   /** D7: skipped entries render in EVERY summary line. */
   function skippedSuffix(skipped?: SkipEntry[]): string {
     if (!skipped || skipped.length === 0) return '';
     const names = skipped.map((s) => s.name).join(', ');
     return ` (${skipped.length} skipped: ${names})`;
   }

   /**
    * The single summary-line/exit-code path for swept commands.
    *
    * Non-abstained exit codes are helper defaults (findings -> 1 for gates);
    * surfaces with richer contracts (e.g. freshness 2 = local edits) apply
    * their own mapping AFTER checking `abstained`.
    */
   export function gateOutcome<F>(
     result: GateResult<F>,
     kind: GateKind,
   ): GateOutcome {
     const suffix = skippedSuffix(result.skipped);
     if (result.checked === 0) {
       return {
         exitCode: kind === 'gate' ? EXIT_ABSTAINED : 0,
         abstained: true,
         summaryLine:
           `${WARN} Abstained ${EMDASH} verified zero items; ` +
           `this is not a pass.${suffix}`,
       };
     }
     if (result.findings.length > 0) {
       return {
         exitCode: kind === 'gate' ? 1 : 0,
         abstained: false,
         summaryLine:
           `${result.findings.length} finding(s) across ` +
           `${result.checked} checked${suffix}`,
       };
     }
     return {
       exitCode: 0,
       abstained: false,
       summaryLine: `All ${result.checked} run check(s) passed${suffix}`,
     };
   }
   ```

4. Run and observe pass: `npx vitest run test/gate-result.test.ts`
5. `npx prettier --write src/core/gate-result.ts test/gate-result.test.ts`
6. `npx tsc --noEmit`
7. Commit:

   ```text
   feat(engine): gate-result abstention helper -- exit 3 reserved for verified-zero (#508)
   ```

### Task 2: Retrofit `FreshnessReport` onto the helper (behavior-preserving)

**Depends on:** Task 1 | **Files:** `ts/src/core/migrator.ts`,
`ts/test/migrator.test.ts`

This is a refactor: the existing suite is the safety net, and it must pass
UNCHANGED (byte-identical markdown, same exit codes, same JSON — `to_markdown`
is not touched). One assertion is added to pin the constant coupling.

1. Establish the green baseline:
   `npx vitest run test/migrator.test.ts test/canary-migrate-cli.test.ts`
2. In `ts/test/migrator.test.ts`, add the import (with the existing imports near
   line 31):

   ```ts
   import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
   ```

   and in the test `'zero matched skills is a loud abstention, not success'`
   (line ~1578), change

   ```ts
   expect(report.exit_code()).toBe(3);
   ```

   to

   ```ts
   expect(report.exit_code()).toBe(3);
   expect(report.exit_code()).toBe(EXIT_ABSTAINED); // #508: same reserved code
   ```

   (Passes already — it pins that the retrofit and the helper agree.)

3. In `ts/src/core/migrator.ts`, add to the existing import block (after the
   `config-validation.js` import, line ~54):

   ```ts
   import { EXIT_ABSTAINED, gateOutcome, GateResult } from './gate-result.js';
   ```

4. In `class FreshnessReport` (line ~662), replace the `abstained` getter and
   `exit_code()` (lines 711-727) with:

   ```ts
   /**
    * The freshness gate as a {@link GateResult}: denominator = skills
    * verified, findings = drift + local edits. Feeds the shared abstention
    * helper (#508) so "verified zero skills" can never render as a pass.
    */
   private gateResult(): GateResult<SkillFreshnessResult> {
     return {
       checked: this.results.length,
       findings: [...this.stale, ...this.local_edits],
     };
   }

   /**
    * A gate that verified zero skills has abstained, not passed (#503): the
    * shape matched nothing, so nothing was checked and "in sync" would be a
    * silent false pass -- the #456 class. Reported as its own exit code and
    * flagged in every output surface. Delegates to the shared helper (#508).
    */
   get abstained(): boolean {
     return gateOutcome(this.gateResult(), 'gate').abstained;
   }

   /**
    * 0 in sync, 1 drift, 2 local edits (safety refusal wins), 3 abstained.
    * The abstention path comes from the shared helper; the 1/2 mapping is
    * this surface's own contract (local edits outrank drift).
    */
   exit_code(): number {
     if (this.abstained) return EXIT_ABSTAINED;
     if (this.has_local_edits) return 2;
     if (this.has_drift) return 1;
     return 0;
   }
   ```

   Leave `to_dict()` and `to_markdown()` untouched
   (`checked: this.results.length` already equals `gateResult().checked`;
   markdown stays byte-identical).

5. Run and observe pass, no other edits needed:
   `npx vitest run test/migrator.test.ts test/canary-migrate-cli.test.ts`
6. `npx prettier --write src/core/migrator.ts test/migrator.test.ts`
7. `npx tsc --noEmit`
8. Commit:

   ```text
   refactor(migrator): freshness gate delegates abstention to gate-result helper (#508)
   ```

### Task 3: Conformance harness + row 1 (`migrate --check`, gate)

**Depends on:** Task 2 | **Files:** `ts/test/gate-conformance.test.ts`

Test-infrastructure task: the harness plus its first row, locking behavior that
already ships (#510). Green on first full run proves the plumbing.

1. Create `ts/test/gate-conformance.test.ts`:

   ```ts
   /**
    * Gate-abstention conformance suite (#508, no-silent-abstention D5).
    *
    * The ROWS table below IS the canonical registry of gates and advisory
    * commands. Every command swept onto the gate-result helper gets a row
    * whose fixture collapses its denominator to zero and whose expectation
    * proves the loud outcome -- the #495 negative-testing discipline applied
    * to every gate. A new gate is not done until it has a row here.
    *
    * Wave 1 seeds the engine layer (migrate --check, migrate dry-run).
    * Waves 2-5 add guardian, npm (doctor / overlay lint), long-tail, and
    * workflow rows; skill-CLI rows live in
    * agents/skills/test/gate-conformance.test.ts (subprocess layer).
    */
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { join } from 'node:path';

   import { describe, expect, it } from 'vitest';

   import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
   import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

   interface GateRow {
     /** Human-readable command line, for the test name and review diffs. */
     command: string;
     layer: 'engine' | 'npm' | 'skill' | 'workflow';
     kind: 'gate' | 'advisory';
     /** Build the zero-denominator fixture; return the CLI invocation. */
     fixture: (base: string) => { args: string[]; home: string };
     /** gate rows exit EXIT_ABSTAINED; advisory rows warn and exit 0. */
     expect: 'exit3' | 'warnLine';
     /** Success copy that must NEVER appear on a zero denominator. */
     forbid: string[];
   }

   /** Harness project whose shape cannot be detected (migrator.test.ts:690). */
   function unknownShapeProject(base: string): {
     project: string;
     home: string;
   } {
     const project = join(base, 'proj');
     const home = join(base, 'home');
     mkdirSync(project, { recursive: true });
     mkdirSync(home, { recursive: true });
     writeFileSync(
       join(project, 'harness.config.json'),
       JSON.stringify({ language: 'unknown-lang', layers: [] }),
       'utf-8',
     );
     mkdirSync(join(project, '.harness'));
     return { project, home };
   }

   const ROWS: GateRow[] = [
     {
       command: 'migrate --check',
       layer: 'engine',
       kind: 'gate',
       expect: 'exit3',
       forbid: ['In sync', 'Migration complete'],
       // #503/#510: unknown shape + empty overlay -> zero skills matched.
       fixture: (base) => {
         const { project, home } = unknownShapeProject(base);
         const overlay = join(base, 'empty-overlay');
         mkdirSync(join(overlay, '.canary', 'skills'), { recursive: true });
         return {
           args: ['migrate', '--path', project, '--check', '--from', overlay],
           home,
         };
       },
     },
   ];

   describe('gate conformance registry (#508)', () => {
     for (const row of ROWS) {
       it(`${row.command} [${row.layer}/${row.kind}] is loud on a zero denominator`, async () => {
         const base = mkTmp();
         try {
           const { args, home } = row.fixture(base);
           const res = await invokeCanary(args, {
             deps: { home: () => home },
           });
           expect(res.stdout.toLowerCase()).toContain('abstained');
           for (const text of row.forbid) {
             expect(res.stdout).not.toContain(text);
           }
           if (row.expect === 'exit3') {
             expect(res.code).toBe(EXIT_ABSTAINED);
           } else {
             expect(res.code).toBe(0);
           }
         } finally {
           rmTmp(base);
         }
       });
     }
   });
   ```

2. Run and observe pass (locks shipped #510 behavior):
   `npx vitest run test/gate-conformance.test.ts`
3. Negative sanity check (proves the harness can fail): temporarily change
   `expect: 'exit3'` to `'warnLine'`, observe the row fail, revert. Do NOT
   commit the mutation.
4. `npx prettier --write test/gate-conformance.test.ts`
5. `npx tsc --noEmit`
6. Commit:
   `test(engine): gate-conformance registry harness, row 1 = migrate --check (#508)`

### Task 4: Dry-run copy fix + registry row 2 (`migrate` dry-run, advisory) (TDD)

**Depends on:** Task 3 | **Files:** `ts/src/core/migrator.ts`,
`ts/test/migrator.test.ts`, `ts/test/gate-conformance.test.ts`

The #504 abstention half: a dry run currently prints "Migration complete." even
when it migrated (and would migrate) nothing. Red at both the unit and
conformance layers first, then one implementation, one commit.

1. RED (unit): append to `ts/test/migrator.test.ts` (after the
   `'MigrationReport apply markdown coverage'` describe, line ~1641):

   ```ts
   // #504 abstention half: a dry run never "completed" a migration, and a
   // dry run that would migrate zero files is an advisory abstention.
   describe('MigrationReport dry-run status', () => {
     it('dry run with work pending says would-migrate, never complete', () =>
       withTmp((root) => {
         makeHarnessProject(root);
         const report = mig().migrate(root, { dryRun: true });
         expect(report.would_migrate_count).toBeGreaterThan(0);
         const md = report.to_markdown();
         expect(md).not.toContain('Migration complete');
         expect(md).toContain('would migrate');
         expect(md).toContain('--apply');
       }));
     it('dry run that would migrate zero files abstains loudly', () =>
       withTmp((root) => {
         makeHarnessProject(root);
         const m = mig();
         m.migrate(root, { dryRun: false }); // apply first: nothing left to do
         const report = m.migrate(root, { dryRun: true });
         expect(report.would_migrate_count).toBe(0);
         const md = report.to_markdown();
         expect(md).not.toContain('Migration complete');
         expect(md.toLowerCase()).toContain('abstained');
       }));
     it('apply-mode completion copy is unchanged', () =>
       withTmp((root) => {
         makeHarnessProject(root);
         const md = mig().migrate(root, { dryRun: false }).to_markdown();
         expect(md).toContain('Migration complete');
       }));
   });
   ```

2. RED (conformance): append row 2 to `ROWS` in
   `ts/test/gate-conformance.test.ts` (add `HarnessMigrator` to the imports from
   `'../src/core/migrator.js'`):

   ```ts
   {
     command: 'migrate (dry run)',
     layer: 'engine',
     kind: 'advisory',
     expect: 'warnLine',
     forbid: ['Migration complete'],
     // #504: pre-apply so the dry run has nothing left to migrate.
     fixture: (base) => {
       const project = join(base, 'proj');
       const home = join(base, 'home');
       mkdirSync(project, { recursive: true });
       mkdirSync(home, { recursive: true });
       writeFileSync(
         join(project, 'harness.config.json'),
         JSON.stringify({ language: 'python', layers: [] }),
         'utf-8',
       );
       mkdirSync(join(project, '.harness'));
       new HarnessMigrator(home).migrate(project, { dryRun: false });
       return { args: ['migrate', '--path', project], home };
     },
   },
   ```

3. Observe both fail (dry run still prints "Migration complete."):
   `npx vitest run test/migrator.test.ts test/gate-conformance.test.ts`
4. Implement in `ts/src/core/migrator.ts`. First, add a getter to
   `class MigrationReport` (after the constructor, line ~911):

   ```ts
   /**
    * The dry run's denominator (#504): config files that would be created,
    * skills that would deploy, workflows that would install. Zero means the
    * dry run has nothing to apply -- an advisory abstention, not a
    * completed migration.
    */
   get would_migrate_count(): number {
     return (
       this.would_create.length +
       this.deployed_skills.filter((r) => r.status === 'dry_run').length +
       this.installed_workflows.filter((r) => r.status === 'dry_run').length
     );
   }
   ```

   Then replace the Status `else` branch in `to_markdown()` (lines 1041-1048):

   ```ts
   } else if (this.dry_run) {
     // #504 abstention half: a dry run never completed anything. Zero
     // pending work is an advisory abstention (D3) -- gateOutcome is the
     // only summary-line path, so the refusal is structural.
     const n = this.would_migrate_count;
     lines.push('## Status', '');
     if (n === 0) {
       lines.push(
         gateOutcome({ checked: 0, findings: [] }, 'advisory').summaryLine,
         '',
         'This dry run would migrate zero files ' +
           EMDASH +
           ' the project already carries everything this migration would ' +
           'produce. If you expected changes, check `--from <overlay>` and ' +
           'the detected framework/shape above.',
         '',
       );
     } else {
       lines.push(
         `Dry run ${EMDASH} would migrate ${n} item(s). ` +
           'Re-run with `--apply` to write them.',
         '',
       );
     }
   } else {
     lines.push(
       '## Status',
       '',
       'Migration complete. Run `canary recommend "<test description>"` to verify framework detection.',
       '',
     );
   }
   ```

   (`gateOutcome` is already imported from Task 2; `EMDASH`/`WARN` already exist
   at line ~85-87.)

5. GREEN:
   `npx vitest run test/migrator.test.ts test/gate-conformance.test.ts test/canary-migrate-cli.test.ts`
6. Flush out any remaining pins on the old dry-run copy across the whole suite:
   `npx vitest run`. Expected: zero other failures (see Uncertainties — only
   `migrator.test.ts:723,730` reference the copy, both as not-contains, both
   still satisfied). If a coverage test does fail on the new copy, update its
   assertion to the "would migrate" phrasing in this same commit.
7. Format:

   ```bash
   npx prettier --write src/core/migrator.ts test/migrator.test.ts test/gate-conformance.test.ts
   ```

8. `npx tsc --noEmit`
9. Commit:

   ```text
   fix(migrator): dry run says would-migrate and abstains loudly at zero, not "Migration complete" (#504)
   ```

### Task 5: Wave boundary gate — full suite + typecheck

**Depends on:** Task 4 | **Files:** none (verification only)

1. From `/Users/bs/Github/canary/ts/`: `npx vitest run` Expected: all 1639
   pre-existing tests plus the new ones (~14: gate-result suite, conformance
   rows, dry-run status trio, coupling assert) pass; zero skips introduced by
   this wave.
2. `npx tsc --noEmit` — clean.
3. Formatting clean:

   ```bash
   npx prettier --check src/core/gate-result.ts src/core/migrator.ts \
     test/gate-result.test.ts test/gate-conformance.test.ts test/migrator.test.ts
   ```

4. ASCII check on new/modified sources (no output expected):

   ```bash
   LC_ALL=C grep -nP '[^\x00-\x7F]' src/core/gate-result.ts \
     test/gate-result.test.ts test/gate-conformance.test.ts
   ```

5. `harness validate` — passes.
6. [checkpoint:human-verify] Show the full-suite summary, the two conformance
   rows' output, and a sample dry-run report (before/after copy). Wave 1 is
   shippable on human confirmation; PR follows the usual flow (doc-drift and
   testing-gap check before opening). Waves 2-5 are separate plans.

---

## Traceability

| Observable truth                         | Delivered by                                |
| ---------------------------------------- | ------------------------------------------- |
| 1-4 (helper semantics, D3/D4/D7)         | Task 1                                      |
| 5 (retrofit, zero behavior change)       | Task 2                                      |
| 6, 9 (registry + row 1)                  | Task 3 (row shape, harness), Task 4 (row 2) |
| 7-8 (dry-run copy + advisory abstention) | Task 4                                      |
| 10 (wave boundary green)                 | Task 5                                      |

## Out of Scope (do not touch in this wave)

- `migrate --json` gaining `checked`/`abstained` for the dry run (the migrate
  JSON block in `cli-commands.ts:553-575`) — lands with the broader JSON sweep.
- The redundant dim hint at `cli-commands.ts:579` ("Re-run with --apply...") —
  harmless duplication, not abstention-related.
- Guardian, doctor, overlay lint, skill CLIs, workflow templates, AGENTS.md
  doctrine text, ADRs, CHANGELOG — waves 2-5.
- `agents/skills/test/gate-conformance.test.ts` — created in wave 4 when the
  first skill-CLI row exists.
