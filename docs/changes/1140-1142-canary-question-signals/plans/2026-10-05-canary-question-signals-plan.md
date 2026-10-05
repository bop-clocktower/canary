# Plan: canary-question categoriser parity and neutral signal ids

**Spec:** `docs/changes/1140-1142-canary-question-signals/proposal.md`
**Issues:** #1140, #1142 · **Complexity:** low · **Phases:** 1

## Tasks

### Task 1: parity test (red check by mutation, #1140)

- File: `agents/skills/test/canary-question.test.ts`
- Import canary-fail-fast `scripts/failures.mjs` (`FAILURE_CATEGORIES`,
  `categorizeFailure`) next to the canary-question copy.
- Use the shared samples from `ts/test/enrich-failure-category.test.ts`. Assert
  every sample gets the same category from both copies. Assert the samples
  produce all seven of fail-fast's `FAILURE_CATEGORIES`.
- This test is green on the current code, because the copies agree. Its red
  state is shown in Task 4.

### Task 2: signal-id tests (red first, #1142)

- Same file. Change the per-category `it.each` to expect `category-timeout`,
  `category-auth` and `category-network`. Expect it to fail.
- Add the naming guard (spec D5). Parse the SKILL.md signal table and add the
  `categoryRows` output for all seven categories. An id that names a hypothesis
  must support exactly that one. Every emitted category id must be listed in
  SKILL.md. Expect it to fail on `category-env`.
- Run `npx vitest run test/canary-question.test.ts` from `agents/skills` and
  confirm both fail.

### Task 3: implementation

- `signals.mjs`: split the ids in `CATEGORY_WEIGHTS`. Replace the "sync by hand"
  comment with a pointer to the parity test.
- `SKILL.md`: replace the two `category-env` rows with three rows.
- Re-run. Expect green.

### Task 4: planted mutation

- Change one rule in the canary-question copy, for example drop `econnreset`
  from `network` or swap the `auth` / `timeout` order. Run the parity test and
  confirm it goes red. Revert, then confirm green and that `git diff` shows the
  file clean of the plant.

### Task 5: docs

- `docs/changes/613-canary-question/proposal.md`: update the table and add a
  dated amendment note (2026-10-05). Leave the 613 plan untouched.
- `CHANGELOG.md` `[Unreleased]`: an entry that names the old id `category-env`
  and the new ids, and says the old id was never in a published release (it came
  after v8.0.0). Add a parity-test note.

### Task 6: gates and provenance

- `agents/skills`: test, typecheck, format:check. `ts/`: build, typecheck,
  format:check, test.
- Run prettier on the touched md and ts files.
- Write `provenance.json` and run `harness waypoint record-provenance`.

## Checkpoints

None. The human decided every fork up front at fleet CONFIRM.
