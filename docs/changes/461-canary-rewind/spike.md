# Spike: is run history complete enough to replay a past run? (#461)

**Date:** 2026-09-16 · **Base:** `origin/main` at `e77f81b7` · **Status:** spike
answered, feeds `proposal.md`

## Question

The issue blocks design on four questions: is the **seed** captured, is the
**test order** recorded, is the **environment** captured to a useful depth, and
is the **commit SHA** recorded with a clean refusal when it is unreachable.

## Method

1. Read the write path end to end: `ts/src/history/schema.ts` (the record
   shapes), `ts/src/history/cli.ts` (`recordContext`, the push/migrate field
   filters `RUN_FIELDS` / `RESULT_FIELDS`), and the three readers in
   `ts/src/history/formats/` (vitest, Playwright, JUnit).
2. Read the one real producer in CI: `.github/workflows/dogfood.yml` runs
   `vitest --reporter=json` and then
   `canary history record ... --suite ts-engine`.
3. Empirical check (throwaway, scratchpad only, nothing committed): ran
   `vitest run src/history/schema.test.ts --reporter=json`, then
   `canary history record` on that report with only `GITHUB_REPOSITORY` and
   `GITHUB_SHA` set, and inspected the NDJSON line that was written.

## Findings

| Dimension      | Captured?   | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed           | **No**      | No `seed` field in `RunInput` or `TestResultInput`; no reader extracts one. The vitest JSON report has no seed key either (top-level keys: `numTotal*`, `snapshot`, `startTime`, `success`, `testResults`). A shuffle seed lives only in runner config or console output.                                                                                             |
| Test order     | **No**      | `tests[]` is written in _report_ order (vitest: file then assertion; Playwright: suite tree walk; JUnit: document order), not execution order. The vitest report carries per-file `startTime`/`endTime`, but the reader drops them. No worker, shard or parallel index is kept. The remote store cannot return an ordered per-test sequence at all (`flake/rows.ts`). |
| Environment    | **No**      | `RunInput.env` and `base_url` exist in the schema but no reader or `recordContext` ever sets them: the recorded line had `"env":null,"base_url":null,"commit_message":null`. No runner version, Node version, OS or arch anywhere in the record.                                                                                                                      |
| Commit SHA     | **Partial** | `commit_sha` is required and validated non-empty. But it defaults to the literal string `local` when neither `--commit` nor `GITHUB_SHA` is set (`cli.ts` `recordContext`); `branch` defaults to `local` the same way. Nothing checks reachability.                                                                                                                   |
| Test identity  | Partial     | `test_name` + `test_file` are kept, but `test_file` is the **absolute path on the recording machine** (observed: a worktree path under the user's home), so it does not resolve on another checkout without normalising.                                                                                                                                              |
| Failure detail | Yes         | `status`, `error_text`, `failure_category`, `retry_count`, `duration_ms` per test.                                                                                                                                                                                                                                                                                    |
| Traces         | **No link** | `canary-instrument` writes a separate `test-results/run.json` (OpenTelemetry, Playwright only). It shares no run id with the history record, so a history row cannot find its traces.                                                                                                                                                                                 |

## Out of scope by nature

Network state, database contents, wall-clock time, external service versions and
secrets are not capturable by a test-report reader and should never be implied
as restored.

## Conclusion

Replay fidelity from today's history is **commit plus test identity only**. Of
the four blocking dimensions, one (commit) is partially present, three (seed,
order, environment) are absent, and the one real producer (dogfood) records none
of them. A replay built on the current store could restore the code and rerun
the named test, and nothing else. The issue's predicted outcome, "partial", is
correct, and the partial is narrow. Rewind therefore needs a capture phase (new,
optional record fields written at record time) before a replay phase is worth
building, and the replay must print a per-dimension restored / not-restored
table rather than a single verdict.
