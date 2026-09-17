# The author obligation for a surviving mutant

**Status:** advisory policy, in force from #486.

A _surviving mutant_ is a deliberate small break in a line your PR added --
flipping `if (force)`, dropping a `.trim()` -- that the test suite ran straight
past without a single failure. It is the one signal coverage cannot give you: a
covered line proves a test EXECUTED that line, a killed mutant proves a test
would FAIL if that line were wrong.

## What you owe a survivor

Exactly one of these, per survivor:

1. **Kill it.** Strengthen or add an assertion until the mutated code fails a
   test. This is the default and the point of the whole check.
2. **Record why not**, on the mutated line:

   ```ts
   const trimmed = reason.trim(); // canary:allow-mutant equivalent under ASCII input
   ```

   The reason is the artifact a reviewer reads, so a bare
   `// canary:allow-mutant` with no reason is ignored and the survivor stays in
   the count. This mirrors `canary:allow-untested` (`suppressionReason` in
   `ts/src/guardian/pr-check.ts`).

Legitimate reasons are narrow: an _equivalent mutant_ (the mutation cannot
change observable behavior), or a line whose only covering suite is one the
mutation run had to exclude.

## What the check owes you

- A denominator on every headline (`12/12 mutants killed`,
  `sampled 150 of 400`).
- The names of the tests that covered a survivor and did not fail -- the
  actionable half of the finding.
- An `abstained` verdict, with its reason, whenever it verified nothing. Zero
  mutants is an abstention, never a pass (ADR 0009).
- The list of test files excluded from the run (`excludedTests`), because a
  mutant only an excluded suite would kill reads as a survivor, and a survivor
  count read without that list overstates what was checked.

## Definitions

| Term                | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| surviving mutant    | A mutation no test failed on. Evidence of a weak assertion.       |
| equivalent mutant   | A mutation that cannot change observable behavior. Not a defect.  |
| mutation abstention | A run that verified nothing, reported as such rather than as 0/0. |
| false-survivor rate | Share of reported survivors a human triages as not actionable.    |
