# Plan: weak-test precision (#929)

Route: bug. Debugging discipline + TDD. Base: `origin/main` at `c41bb85d`.

## Defects (reproduced)

`guardian pr-check --diff <pr> --format json` on the base build reports
weak-test findings on correct tests: #798 → 2, #863 → 1, #916 → 1.

1. **Truncated block span.** `testBlockEnd` in `ts/src/guardian/weak-test.ts`
   returns the last visible line when a block does not close inside the diff's
   visible run, so an out-of-view `expect` reads as "asserts nothing".
2. **Helper-delegated assertions.** `ASSERTIONS.vitest` in
   `ts/src/core/quality-scorer.ts` lacks `assert\w*(`, and a same-file helper
   that asserts is never recognised.
3. **No location.** Evidence is generic and `added_ranges` covers the whole
   unit, not the test.

## Tasks

1. Red: add `ts/test/guardian-weak-test-precision.test.ts` from the real shapes
   (#798 rename, #916 hunk 8 setup edit, pytest truncation, #863 helper,
   `assert*` prefix, #935 import/fixture edits) plus true positives (empty `it`,
   non-asserting helper) that assert title + line span in evidence.
2. Fix 1: `testBlockEnd` returns `null` when the end is not reached; the caller
   abstains. A new file (`--- /dev/null`) is fully visible, so its last line is
   EOF and closes a block. Same rule for the Python indentation path.
3. Fix 2a: widen the vitest pattern `\bassert\s*\(` → `\bassert\w*\s*\(`.
4. Fix 2b: collect helper names defined in the same file whose closed body
   contains an assertion token. Source: the diff's visible lines, unioned with
   the file's own text at the repo root (`.`, the CLI's existing repoRoot
   convention) when it exists. A test span calling such a helper asserts.
5. Fix 3: one finding per weak block; evidence
   `added test "<title>" (L<start>–L<end>) asserts nothing …`; `added_ranges` is
   `[[start, end]]`.
6. Re-run guardian on #798/#863/#916 diffs: expect 0 weak-test findings.
7. Gates from `ts/` (build, typecheck, format:check, test) and ratchets
   (check-arch, check-perf, entropy, dead exports).

## Out of scope

`pr-check.ts`, `cli.ts`, `orchestrator.ts`, `report-tier.ts`, `paths.ts`.
Findings stay `LOW` and advisory.
