# Plan: pin the clock in the voice invariant test (#1315)

## Root cause

`agents/skills/test/canary-test-reporter-voice.test.ts` checks that
canary-test-reporter's `--json-out` is byte-identical with flavor on and off. It
calls `main()` twice in-process and compares the sha256 of both files.
`renderJson()` in `canary-test-reporter/scripts/json_report.mjs` stamps
`generated_at` from `new Date()` at second precision. When the two runs fall on
different sides of a whole second, that one field differs and so does the hash.
CI run 37982635124 failed this way on attempt 1 and passed on attempt 2 with the
same SHA. No other time source feeds the output: a grep of `scripts/` finds no
`Date.now`, `performance` or `hrtime`.

The env-leak half of #1315 was already fixed: the top-level `afterEach` deletes
`CANARY_NO_FLAVOR` and `NO_FLAVOR`. This plan checks that fix and does not
change it.

## Decided fork

F1-A (human, CONFIRM): pin the clock with `vi.useFakeTimers` and
`vi.setSystemTime` around both runs, so every byte still has to match. Do not
normalize or exclude `generated_at`. Do not add retries, `skip`, or a looser
assertion.

## Tasks

1. Reproduce: add a case that sleeps on the real clock until just past the next
   whole second between the two runs. Expect it to fail every time before the
   fix.
2. Fix: add `beforeEach` with `vi.useFakeTimers({ toFake: ['Date'] })` and
   `vi.setSystemTime(PINNED)`, and `afterEach` with `vi.useRealTimers()`, all
   inside the invariant `describe`. Only `Date` is faked, because `main()` is
   synchronous and never waits on a timer.
3. Regression guard: keep the boundary-crossing case. It also asserts that
   `generated_at` equals the pinned instant.
4. Revert check: take the pin out, confirm the guard goes red, then put the pin
   back.

## Verification

- Before the fix, the reproducing case failed 3 of 3 runs (hash mismatch).
- After the fix, the voice test file passed 20 of 20 runs (19 tests each).
- With the pin taken out, the guard failed 3 of 3 runs (`generated_at` was the
  wall-clock time, not `2026-01-01T00:00:00Z`).
- Skills suite (`npm test` in `agents/skills`): 56 files, 2444 tests passed.
  `typecheck` and `format:check` are clean.
