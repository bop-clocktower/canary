# Plan: Remove `classifyFlakeTrend` dead code

**Date:** 2026-09-22 | **Spec:**
`docs/changes/990-remove-classify-flake-trend/proposal.md` | **Tasks:** 4 |
**Time:** ~15 min | **Integration Tier:** small

## Goal

Delete `classifyFlakeTrend`, `FlakeTrend`, and `TREND_THRESHOLD` from
`ts/src/history/detector.ts` and their test coverage from
`ts/src/history/detector.test.ts`, leaving `detectRegressions` and its
supporting types untouched.

## Evidence this is safe to delete

`git grep -n classifyFlakeTrend -- ts/` and `git grep -n FlakeTrend -- ts/` (run
2026-09-22, HEAD of `chore/990-remove-classify-flake-trend`) return hits
**only** inside `detector.ts` (the definition) and `detector.test.ts` (its own
tests). No CLI command, MCP tool, skill, script, or other module references
either symbol. This grep is the load-bearing evidence for the deletion — see "A
note on evidence" below.

## Observable Truths (Acceptance Criteria)

1. `git grep -n classifyFlakeTrend -- ts/` returns nothing.
2. `git grep -n FlakeTrend -- ts/` returns nothing.
3. `detectRegressions`, `RegressionResult`, `BAD_STATUSES`, and the
   `TimelineEntry` import in `detector.ts` are byte-for-byte unchanged.
4. `detectRegressions`'s existing test block in `detector.test.ts` is
   byte-for-byte unchanged.
5. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`, and
   `npm run test` all pass (there is no `lint` script — do not look for one).
6. Diff touches exactly two files: `ts/src/history/detector.ts` and
   `ts/src/history/detector.test.ts`.

## A note on evidence (read before treating this as routine)

**Green gates are weak evidence for a deletion.** Build/typecheck passing after
removing a symbol mostly proves the compiler found no remaining reference —
which the grep in Task 1 already established, before any code changed. Tests
passing proves the _remaining_ tests (for `detectRegressions`) still pass; it
says nothing about whether the deleted behavior mattered, because by
construction nothing remains to test it against.

The grep for zero callers (Task 1) is the load-bearing check. Gates in Task 3
are there to catch a mechanical mistake (unbalanced braces, orphaned import, a
stray reference the grep somehow missed, formatting drift) — not to validate the
deletion decision itself. That decision was made in the spec (D1, human-selected
option 2 on issue #990), not by this plan.

## Concurrency note

A peer agent is editing `ts/src/history/` concurrently. Keep this diff scoped to
exactly the two files named above. Before starting Task 2, re-run the Task 1
greps against current HEAD (not a cached read) in case the peer agent already
touched `detector.ts` or `detector.test.ts` — if either file differs from what
Task 1 recorded, stop and re-derive the line ranges rather than applying line
numbers blindly.

## File Map

- MODIFY `ts/src/history/detector.ts` (delete lines 10-14 `FlakeTrend` enum,
  line 16 `TREND_THRESHOLD`, lines 18-33 `classifyFlakeTrend`)
- MODIFY `ts/src/history/detector.test.ts` (delete `classifyFlakeTrend` +
  `FlakeTrend` from the import block, delete the
  `describe('classifyFlakeTrend', ...)` block, lines 24-34)

No other files change. No production code, docs, ADRs, or roadmap entries are
touched (spec decision D4).

## Tasks

### Task 1: Re-verify zero-caller evidence immediately before editing

**Depends on:** none | **Files:** none (read-only)

1. Run, from the repo root:

   ```console
   git grep -n classifyFlakeTrend -- ts/
   git grep -n FlakeTrend -- ts/
   ```

2. Confirm every hit is inside `ts/src/history/detector.ts` or
   `ts/src/history/detector.test.ts`. If any hit appears elsewhere (e.g. the
   peer agent introduced a new reference), STOP — do not proceed to Task 2.
   Escalate instead of deleting a symbol that gained a caller.
3. No commit for this task — it is a verification gate, not a code change.

### Task 2: Delete the dead code and its test block

**Depends on:** Task 1 | **Files:** `ts/src/history/detector.ts`,
`ts/src/history/detector.test.ts`

1. In `ts/src/history/detector.ts`, delete:
   - `export enum FlakeTrend { ... }` (the `Rising`/`Falling`/`Stable` enum)
   - `const TREND_THRESHOLD = 0.1;`
   - `export function classifyFlakeTrend(rates: number[]): FlakeTrend { ... }`
     (the whole function body)

   Leave the `import type { TimelineEntry } from './record.js';` line, the blank
   lines around the file header comment, and everything from
   `export interface RegressionResult { ... }` onward untouched.

2. In `ts/src/history/detector.test.ts`:
   - In the import block, remove `classifyFlakeTrend,` and `FlakeTrend,` from
     the named imports of `./detector.js`, keeping `detectRegressions`.
   - Delete the entire `describe('classifyFlakeTrend', () => { ... });` block
     (the three `it(...)` cases: fewer-than-two-points stable, rising/falling
     detection, stable-within-threshold).
   - Leave the `entry(...)` helper function and the
     `describe('detectRegressions', ...)` block untouched.

3. Read back both files in full to confirm:
   - `detector.ts` has no remaining reference to `FlakeTrend`,
     `TREND_THRESHOLD`, or `classifyFlakeTrend`.
   - `detector.test.ts` compiles logically (no dangling comma in the import
     list, no orphaned closing brace from the removed `describe` block).

4. No commit yet — commit happens after gates pass in Task 3, per repo
   convention of one atomic commit per reviewed change (this is a single small
   change, so one commit covers both files).

### Task 3: Run the four gates from `ts/`

**Depends on:** Task 2 | **Files:** none (verification only)

1. `cd ts`
2. If `ts/node_modules` is absent, run `npm ci` first (recorded as present at
   plan time, 2026-09-22 — re-check, do not assume it survived).
3. Run each gate individually and read its actual exit status (do not pipe
   through something that swallows it):

   ```console
   npm run build
   npm run typecheck
   npm run format:check
   npm run test
   ```

4. There is no `lint` script in `ts/package.json` — do not add one and do not
   search for a missing gate that was never there.
5. If `format:check` fails on the edited files, run
   `npx prettier --write ts/src/history/detector.ts ts/src/history/detector.test.ts`
   and re-run `npm run format:check` and `npm run test` (formatting can shift
   line numbers, re-verify the deletion is still complete with the Task 1
   greps).
6. Treat all four as required — remember these gates are corroborating evidence
   for "no compile/format regression," not proof the deletion was correct (see
   "A note on evidence" above). A failure here is a mechanical mistake in Task 2
   to fix, not a reason to reconsider whether to delete.

### Task 4: Re-confirm scope, then commit

**Depends on:** Task 3 | **Files:** `ts/src/history/detector.ts`,
`ts/src/history/detector.test.ts`

1. Run `git status --short` and `git diff --stat` from the repo root. Confirm
   exactly two files are modified: `ts/src/history/detector.ts` and
   `ts/src/history/detector.test.ts`. If anything else appears modified (e.g. a
   peer agent's concurrent edit got staged accidentally, or `npm ci` touched a
   lockfile), stop and unstage/ investigate before committing — do not sweep it
   in with `git add -A`.
2. Re-run the Task 1 greps one final time against the working tree to confirm
   zero remaining hits outside history that git will now record as deleted.
3. Stage only the two files:

   ```console
   git add ts/src/history/detector.ts ts/src/history/detector.test.ts
   ```

4. Commit:

   ```console
   git commit -m "fix(history): delete classifyFlakeTrend dead code

   Closes #990"
   ```

   (Conventional Commits type `fix` fits a dead-code removal that closes a
   tracked issue; `Closes #990` per spec decision D5 — the issue's stated
   acceptance criteria are fully satisfied by this deletion.)

5. Do not push. Do not open a PR as part of this plan — that is a downstream
   step outside this plan's scope (fleet build lane handles push/PR per its own
   convention).

## Success Criteria (repeat, for the executor to check off)

- [ ] `git grep -n classifyFlakeTrend -- ts/` → no output
- [ ] `git grep -n FlakeTrend -- ts/` → no output
- [ ] `detectRegressions`, `RegressionResult`, `BAD_STATUSES`, `TimelineEntry`
      import unchanged
- [ ] `detectRegressions` test block unchanged
- [ ] `npm run build`, `npm run typecheck`, `npm run format:check`,
      `npm run test` all pass from `ts/`
- [ ] Diff is exactly two files
- [ ] Single commit, `Closes #990`, not pushed
