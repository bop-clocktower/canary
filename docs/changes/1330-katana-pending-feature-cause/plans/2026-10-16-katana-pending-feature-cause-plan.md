# Plan: katana `pending-feature` ledger cause

**Date:** 2026-10-16 | **Spec:**
`docs/changes/1330-katana-pending-feature-cause/proposal.md` | **Tasks:** 7 |
**Time:** ~25 min | **Integration Tier:** small

## Goal

The katana quarantine ledger accepts a fifth cause, `pending-feature`, that
requires an `issue`. manhunter's TS mirror of the issue-requiring list is
guarded by a parity test, so the two lists cannot drift apart without a red
test.

## Observable Truths (Acceptance Criteria)

1. The system shall export
   `CAUSES = ['flaky', 'product-defect', 'blocked-data', 'pending-feature', 'obsolete']`
   and
   `CAUSES_REQUIRING_ISSUE = ['product-defect', 'blocked-data', 'pending-feature']`
   from `agents/skills/claude-code/canary-katana/scripts/ledger.mjs` (Tasks 1,
   3).
2. When a `pending-feature` row with an `issue` is appended for a pair that has
   a causeless row, the ledger shall keep exactly one row for the pair: the
   `pending-feature` one (Tasks 1, 3).
3. If a ledger row has `cause: 'pending-feature'` and `issue: ''`, then
   `ledgerSection` shall emit
   `<test> (<file>): out as pending-feature with no linked issue` (Tasks 2, 5).
4. If a `pending-feature` row has an `issue`, then `ledgerSection` shall not
   emit a "no linked issue" eye for it (Tasks 2, 5).
5. For every cause in katana's `CAUSES` (at least 5), an issueless row shall
   raise the "no linked issue" eye if and only if katana's
   `CAUSES_REQUIRING_ISSUE` contains that cause. A recorded red run against the
   old TS mirror proves the test can fail (Tasks 4, 5).
6. Existing causes behave as before. The only existing assertion that changes is
   the hard-coded list (all tasks; Task 7 gates).
7. The SKILL.md "Schema v2" section and the CHANGELOG `[Unreleased]` entry name
   the new cause. The historical #771 changelog entry is untouched (Task 6).
8. All gates pass: `ts/` build, typecheck, format:check, test, and
   `agents/skills` test (Task 7).

## Uncertainties

- [ASSUMPTION] A `ts/test` file may dynamically import an `agents/skills` `.mjs`
  through `pathToFileURL`. Precedent: `ts/test/arch-verdict.test.ts:125` imports
  `scripts/arch-verdict.mjs` this way, and the spec cites
  `ts/test/batwoman-registry.test.ts:71` for reading across the `ts/` →
  `agents/` boundary. A dynamic import adds no static edge, so `check-deps` is
  not affected.
- [ASSUMPTION] The `ts` vitest suite's coverage thresholds are unaffected by a
  test-only file. `ledger.ts` is already covered.
- [ASSUMPTION] Changelog style is a trailing `(#1330)`, not `Refs #1330`. Every
  entry in `CHANGELOG.md` ends `(#NNNN)` (e.g. lines 28 and 37), and the brief
  asked for "consistent with file". No closing keyword goes next to `#1330`.
- [DEFERRABLE] Exact SKILL.md wording. The required content is fixed in Task 6.
- **Planted-positive ordering (planning decision):** the parity test can only go
  red when katana and the mirror disagree. Written before either list changes,
  both lists agree and the test is green. So Task 3 updates `ledger.mjs` first,
  Task 4 adds the parity test and records the red against the old TS mirror, and
  Task 5 fixes the mirror.

## File Map

- MODIFY `agents/skills/test/canary-katana.test.ts` (list assertion ~L676-688;
  new supersede case)
- MODIFY `ts/test/manhunter-sections.test.ts` (new case in
  `describe('quarantine section')`, ~L503)
- MODIFY `agents/skills/claude-code/canary-katana/scripts/ledger.mjs` (L39-48:
  doc comment + constants)
- CREATE `ts/test/manhunter-ledger-cause-parity.test.ts`
- MODIFY `ts/src/analysis/manhunter/ledger.ts` (L20-21: mirror + comment)
- MODIFY `agents/skills/claude-code/canary-katana/SKILL.md` ("Schema v2",
  L260-263)
- MODIFY `CHANGELOG.md` (`## [Unreleased]`, L14)

## Skeleton

Not produced: 7 tasks is under the threshold of 8 for standard rigor.

## Tasks

### Task 1: katana tests for the new cause (red)

**Depends on:** none | **Files:** `agents/skills/test/canary-katana.test.ts`

1. In `agents/skills/test/canary-katana.test.ts`, replace the body of
   `it('names the causes, and which of them require an issue link', ...)`
   (~L676) with:

   ```ts
   it('names the causes, and which of them require an issue link', () => {
     expect(ledger.CAUSES).toEqual([
       'flaky',
       'product-defect',
       'blocked-data',
       'pending-feature',
       'obsolete',
     ]);
     // The three where the TEST is correct and someone else owns the fix:
     // a product defect, missing data, or a feature that has not shipped.
     expect(ledger.CAUSES_REQUIRING_ISSUE).toEqual([
       'product-defect',
       'blocked-data',
       'pending-feature',
     ]);
   });
   ```

2. Directly after the existing
   `it('a causeless row is dropped when a caused row already exists', ...)` case
   (~L622-633), insert:

   ```ts
   it('a pending-feature row supersedes a causeless row for the same pair (#1330)', () => {
     const p = path.join(mkTmp(), 'q.json');
     ledger.appendEntries(p, [entry({ kind: 'skipped' })]);
     const doc = ledger.appendEntries(p, [
       entry({
         kind: 'skipped',
         cause: 'pending-feature',
         issue: 'acme/widgets#3100',
       }),
     ]);
     expect(doc.entries).toHaveLength(1);
     expect(doc.entries[0].cause).toBe('pending-feature');
     expect(doc.entries[0].issue).toBe('acme/widgets#3100');
   });
   ```

3. From `agents/skills/`, run
   `npx vitest run test/canary-katana.test.ts -t "names the causes"`. Expect
   **red**: `CAUSES` is missing `pending-feature`. Record the failure output.
   The supersede case may already pass, because supersede keys on a non-empty
   cause and not on list membership. That is expected: it pins the behaviour
   (truth 2) and is not the red signal.
4. `npx prettier --write test/canary-katana.test.ts` (from `agents/skills/`).
5. Run `harness validate` from the repo root.
6. Commit:
   `test(katana): expect a pending-feature cause that requires an issue (#1330)`

### Task 2: manhunter eye test for pending-feature (red)

**Depends on:** none | **Files:** `ts/test/manhunter-sections.test.ts`

1. In `ts/test/manhunter-sections.test.ts`, inside
   `describe('quarantine section', ...)` and after the
   `'is fed and flags untracked defects, expired rows and causeless removals'`
   case (~L503), insert:

   ```ts
   it('flags an untracked pending-feature row, not a linked one (#1330)', () => {
     const row = (over: Record<string, string>) => ({
       test: 't',
       file: 'tests/t.py',
       kind: 'skipped',
       marker: 'skip',
       commit: 'c',
       author: 'Ada',
       date: '2026-09-01',
       reason: 'r',
       cause: 'pending-feature',
       issue: '#9',
       expiry: '',
       ...over,
     });
     const s = ledgerSection(
       write('q.json', {
         schema_version: 2,
         entries: [
           row({ test: 'untracked', issue: '' }),
           row({ test: 'linked' }),
         ],
       }),
       now,
     );
     expect(s.status).toBe('fed');
     expect(s.denominator).toBe('2 ledger rows');
     expect(s.eyes).toEqual([
       'untracked (tests/t.py): out as pending-feature with no linked issue',
     ]);
   });
   ```

2. From `ts/`, run
   `npx vitest run test/manhunter-sections.test.ts -t "pending-feature"`. Expect
   **red**: `eyes` is `[]`. Record the output.
3. `npx prettier --write test/manhunter-sections.test.ts` (from `ts/`).
4. Run `harness validate` from the repo root.
5. Commit:
   `test(manhunter): expect an eye on an untracked pending-feature row (#1330)`

### Task 3: add pending-feature to katana's ledger constants (green katana)

**Depends on:** Task 1 | **Files:**
`agents/skills/claude-code/canary-katana/scripts/ledger.mjs`

1. In `ledger.mjs`, replace L39-48 (the doc comment, `CAUSES`, and
   `CAUSES_REQUIRING_ISSUE`) with:

   ```js
   /**
    * Why a test is out of the suite. The middle values (product-defect,
    * blocked-data, pending-feature) are the ones where the TEST IS CORRECT and
    * someone else owns the fix -- a product defect, missing test data, or a
    * feature that has not shipped (or is flag-disabled). A producer must
    * require an `issue` for them: an untracked "the product is broken" or "the
    * feature isn't built" note decays into an unexplained skip within a
    * release. Release rule for every cause: remove the row when the test
    * passes live, not when the ticket closes (#1330).
    *
    * manhunter mirrors CAUSES_REQUIRING_ISSUE in
    * ts/src/analysis/manhunter/ledger.ts; the parity test
    * ts/test/manhunter-ledger-cause-parity.test.ts fails if they disagree.
    */
   export const CAUSES = [
     'flaky',
     'product-defect',
     'blocked-data',
     'pending-feature',
     'obsolete',
   ];

   /** Causes for which a row without an `issue` is not a real record. */
   export const CAUSES_REQUIRING_ISSUE = [
     'product-defect',
     'blocked-data',
     'pending-feature',
   ];
   ```

2. From `agents/skills/`, run `npx vitest run test/canary-katana.test.ts`.
   Expect **green**, including both Task 1 cases.
3. `npx prettier --write claude-code/canary-katana/scripts/ledger.mjs` (from
   `agents/skills/`).
4. Run `harness validate` from the repo root.
5. Commit:
   `feat(katana): add a pending-feature cause that requires an issue (#1330)`

### Task 4: parity test, planted red against the old TS mirror

**Depends on:** Task 3 | **Files:**
`ts/test/manhunter-ledger-cause-parity.test.ts`

1. Create `ts/test/manhunter-ledger-cause-parity.test.ts`:

   ```ts
   /**
    * manhunter's quarantine section mirrors canary-katana's
    * CAUSES_REQUIRING_ISSUE (ts/src/analysis/manhunter/ledger.ts), because the
    * published `ts/` package does not ship agents/skills and cannot import
    * ledger.mjs at runtime. This test checks the mirror against katana's own
    * lists (#1330). For EVERY cause katana knows, an issueless row must raise
    * the "no linked issue" eye if and only if katana requires an issue for that
    * cause. The check is on behaviour, not on the mirror's array, so a reorder
    * or a refactor of rowEyes cannot hide a missing cause.
    */
   import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { dirname, join } from 'node:path';
   import { fileURLToPath, pathToFileURL } from 'node:url';

   import {
     afterEach,
     beforeAll,
     beforeEach,
     describe,
     expect,
     it,
   } from 'vitest';

   import { ledgerSection } from '../src/analysis/manhunter/ledger.js';

   const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
   const KATANA_LEDGER = join(
     REPO_ROOT,
     'agents',
     'skills',
     'claude-code',
     'canary-katana',
     'scripts',
     'ledger.mjs',
   );

   interface KatanaLedger {
     CAUSES: string[];
     CAUSES_REQUIRING_ISSUE: string[];
   }

   let katana: KatanaLedger;
   beforeAll(async () => {
     katana = (await import(pathToFileURL(KATANA_LEDGER).href)) as KatanaLedger;
   });

   let tmp: string;
   beforeEach(() => {
     tmp = mkdtempSync(join(tmpdir(), 'manhunter-parity-'));
   });
   afterEach(() => {
     rmSync(tmp, { recursive: true, force: true });
   });

   function issuelessEyes(cause: string): string[] {
     const path = join(tmp, `q-${cause}.json`);
     writeFileSync(
       path,
       JSON.stringify({
         schema_version: 2,
         entries: [
           {
             test: 't',
             file: 'tests/t.py',
             kind: 'skipped',
             marker: 'skip',
             commit: 'c',
             author: 'Ada',
             date: '2026-09-01',
             reason: 'r',
             cause,
             issue: '',
             expiry: '',
           },
         ],
       }),
     );
     const s = ledgerSection(path, '2026-09-28T00:00:00Z');
     expect(s.status).toBe('fed');
     return s.eyes.filter((e) => e.includes('no linked issue'));
   }

   describe('manhunter mirrors katana CAUSES_REQUIRING_ISSUE (#1330)', () => {
     it('has a real denominator: katana names at least five causes', () => {
       expect(katana.CAUSES.length).toBeGreaterThanOrEqual(5);
       for (const c of katana.CAUSES_REQUIRING_ISSUE) {
         expect(katana.CAUSES).toContain(c);
       }
     });

     it('flags an issueless row iff katana requires an issue for its cause', () => {
       const mismatches = katana.CAUSES.filter((cause) => {
         const flagged = issuelessEyes(cause).length > 0;
         return flagged !== katana.CAUSES_REQUIRING_ISSUE.includes(cause);
       });
       expect(mismatches).toEqual([]);
     });
   });
   ```

2. **Planted positive.** From `ts/`, run
   `npx vitest run test/manhunter-ledger-cause-parity.test.ts`. The TS mirror
   still reads `['product-defect', 'blocked-data']`, so expect **red**:
   `expected [ 'pending-feature' ] to deeply equal []`. The denominator case
   passes (5 causes). Record the output verbatim for the PR body.
3. `npx prettier --write test/manhunter-ledger-cause-parity.test.ts` (from
   `ts/`).
4. Run `harness validate` from the repo root.
5. Commit:
   `test(manhunter): guard the ledger cause mirror with a katana parity test (#1330)`

### Task 5: update the TS mirror (green)

**Depends on:** Task 2, Task 4 | **Files:**
`ts/src/analysis/manhunter/ledger.ts`

1. In `ts/src/analysis/manhunter/ledger.ts`, replace L20-21:

   ```ts
   /** Mirrors CAUSES_REQUIRING_ISSUE in canary-katana's ledger.mjs. */
   const CAUSES_REQUIRING_ISSUE = ['product-defect', 'blocked-data'];
   ```

   with:

   ```ts
   /**
    * Mirrors CAUSES_REQUIRING_ISSUE in canary-katana's ledger.mjs. It is a copy
    * because the published package does not ship agents/skills.
    * ts/test/manhunter-ledger-cause-parity.test.ts fails if the copy drifts
    * from katana's list (#1330).
    */
   const CAUSES_REQUIRING_ISSUE = [
     'product-defect',
     'blocked-data',
     'pending-feature',
   ];
   ```

2. From `ts/`, run
   `npx vitest run test/manhunter-ledger-cause-parity.test.ts test/manhunter-sections.test.ts`.
   Expect **green**. The Task 2 and Task 4 reds are now fixed.
3. `npx prettier --write src/analysis/manhunter/ledger.ts` (from `ts/`).
4. Run `harness validate` and `harness check-deps` from the repo root.
5. Commit: `feat(manhunter): flag untracked pending-feature quarantines (#1330)`

### Task 6: docs — SKILL.md Schema v2 and CHANGELOG

**Depends on:** Task 3, Task 5 | **Files:**
`agents/skills/claude-code/canary-katana/SKILL.md`, `CHANGELOG.md`

1. In `agents/skills/claude-code/canary-katana/SKILL.md`, replace the paragraph
   at L260-263 (`` `reason` and `cause` are deliberately separate. … ``) with:

   ```markdown
   `reason` and `cause` are deliberately separate. `reason` is **derived** (the
   commit subject). `cause` is **asserted** — one of `flaky`, `product-defect`,
   `blocked-data`, `pending-feature`, `obsolete`. Collapsing them would dress an
   auto-derived string up as a claim someone stands behind.

   Three causes **require an `issue`**: `product-defect`, `blocked-data` and
   `pending-feature`. In each, the test is correct and someone else owns the
   fix, so a row with no link decays into an unexplained skip. Use
   `pending-feature` when a correct test covers behaviour that has not shipped,
   or has shipped behind a flag that is off; link the feature's ticket. It is
   not `blocked-data`: the owner and the trigger differ (the feature team ships
   the feature, not someone supplying environment data), and filing one as the
   other sends whoever looks for data work to feature work. The release rule is
   the same for every cause: **remove the row when the test passes live**, not
   when the ticket closes. A closed ticket with a still-failing test is exactly
   what the ledger exists to keep visible (#1330).
   ```

2. In `CHANGELOG.md`, directly under `## [Unreleased]` (L14), insert:

   ```markdown
   ### Added

   - **katana `pending-feature` ledger cause.** The quarantine ledger has a
     fifth cause for a correct test whose feature has not shipped or is behind a
     flag that is off. Before this, producers filed those rows as
     `blocked-data`, so dashboards could not tell "waiting on the feature" from
     "waiting on test data". Like `product-defect` and `blocked-data`, it
     requires an `issue`: manhunter flags
     `out as pending-feature with no linked issue`. A new parity test fails if
     manhunter's copy of the issue-requiring causes drifts from katana's. No
     schema bump; existing rows are unchanged (#1330).
   ```

   Leave the historical #771 entry (four causes) as written.

3. From the repo root, run
   `npx prettier --write CHANGELOG.md agents/skills/claude-code/canary-katana/SKILL.md`,
   then `git diff --stat` to confirm only these two files changed.
4. Check that no other file restates the list:
   `git grep -n "'blocked-data'" -- ':!CHANGELOG.md' ':!docs/changes'`. Expect
   hits only in `ledger.mjs`, `ts/src/analysis/manhunter/ledger.ts`, and tests.
   Any other hit is a stale mirror: flag it in the PR and do not fix it
   silently.
5. Run `harness validate` from the repo root.
6. Commit: `docs(katana): document the pending-feature cause (#1330)`

### Task 7: four gates [checkpoint:human-verify]

**Depends on:** Task 6 | **Files:** none (verification only)

Run from the pinned Node (`nvm use`, `.nvmrc` = 22.23.2). Do not pipe a gate
into `tail` and then read `$?`; check each exit code directly.

1. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
   `npm test`. Each must exit 0. Read the vitest summary and confirm the parity
   file ran 2 tests (non-zero denominator).
2. From `agents/skills/`: `npm test`, `npm run typecheck`,
   `npm run format:check`. Each must exit 0.
3. From the repo root: `harness validate`, `harness check-deps`.
4. If any gate fails, fix it in a new commit. Never use `--no-verify`. A failure
   unrelated to this change still gets fixed or filed as an issue.
5. Show the human: the planted-red output from Task 4, the gate results, and
   `git log --oneline main..HEAD`.

## Traceability

| Truth | Tasks |
| ----- | ----- |
| 1     | 1, 3  |
| 2     | 1, 3  |
| 3     | 2, 5  |
| 4     | 2, 5  |
| 5     | 4, 5  |
| 6     | 7     |
| 7     | 6     |
| 8     | 7     |
