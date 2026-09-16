# Spike: can run history drive predictive test ordering? (#460)

> **Status: spike complete 2026-09-16.** Read-only investigation. No product
> code changed. The one throwaway script used (a field counter over an NDJSON
> file) lived in a session scratchpad and is not committed.

## Question

Issue #460 blocks any build work on one question: does the history store carry
what predictive ordering needs? It splits into four sub-questions. If any answer
is "no", the first deliverable is a history-store change, not a skill.

## Verdict

**Partly no.** The schema is close to ready. The data does not exist yet, and
two fields are not joinable to a diff as written. The first deliverable is
therefore a history-store change (persistence and path normalization), with the
ordering skill after it. See `proposal.md` phases 1 and 2.

| #   | Sub-question                                | Answer                               | Blocks the skill?     |
| --- | ------------------------------------------- | ------------------------------------ | --------------------- |
| Q1  | Per-test pass/fail history, not aggregates? | **Yes**                              | No                    |
| Q2  | Results keyed to a commit/diff?             | **Commit yes; diff-joinable no**     | Yes, until normalized |
| Q3  | Enough volume/retention for a signal?       | **No: canary's own store has 1 run** | Yes                   |
| Q4  | Can the supported runners consume an order? | **Partly: file-level for most**      | Shapes the design     |

## Evidence

### Q1: per-test history is recorded

- `ts/src/history/schema.ts`: `serializeLocalRecord` writes one NDJSON line per
  run with a nested `tests` array. Each `TestResultInput` carries `test_name`,
  `test_file`, `status` (`passed | failed | flaky | skipped`),
  `failure_category`, `error_text`, `retry_count`, `duration_ms` and `tags`.
- The three readers in `ts/src/history/formats/` (vitest JSON, Playwright JSON,
  JUnit XML) all emit per-test rows. `canary history record`
  (`ts/src/history/cli.ts`, shipped by #538, now closed) is the writer.
- `NdjsonHistoryStore.queryTimeline(testName)` already returns a per-test
  timeline, so "how often has test X failed" is one existing query.

Caveat: vitest has no flaky status, so a retried-then-passed vitest test is
recorded as `passed` (`run-recorder.ts` header). Ordering on vitest failure
rates therefore under-counts flakes. That is acceptable for ordering: a missed
flake only costs position, never a skipped test.

### Q2: keyed to a commit, not joinable to a diff as-is

- Every run has `commit_sha` and `branch`. For `record`, these default to
  `GITHUB_SHA` / `GITHUB_REF_NAME`, else the literal `'local'` (`cli.ts` around
  line 313). A `'local'` sha cannot be joined to anything.
- **No changed-file list is stored.** It is derivable at query time with
  `git diff --name-only <sha>^ <sha>` when the clone has that history, so this
  needs no schema change, but it does need a clone with enough depth.
- **`test_file` is not a stable join key.** The vitest reader writes `file.name`
  (`formats/vitest-report.ts` line 77). In vitest's JSON reporter that is an
  absolute path on the machine that ran the suite (for example
  `/home/runner/work/<repo>/<repo>/ts/src/...`). Playwright writes a path
  relative to its `testDir`. JUnit writes the `file` attribute only when the
  producer set one, else `''` (`formats/junit-report.ts` line 212). Three
  producers give three path bases, and one of them is often empty. A diff path
  (`ts/src/history/cli.ts`) matches none of them without normalization.
- The committed fixture `ts/test/fixtures/history-v2.jsonl` (10 runs, 19 test
  rows, 10 distinct commits) has **no `test_file` on any row**, so no existing
  test exercises a file-keyed join. Counted with the scratch script: fields
  present were `test_name` 19/19, `status` 19/19, `area` 17/19,
  `failure_category` 2/19, `error_text` 2/19.

### Q3: there is no accumulated history

- The only producer of real history is the `fleet-health` job in
  `.github/workflows/dogfood.yml`. It checks out, runs the suite, runs
  `history record`, then analyzes. It has **no cache restore, no artifact
  download and no remote store URL**, so every run starts from an empty
  `test-results/reports/history-v2.jsonl`.
- The latest `main` run of that workflow (run 35161115220, 2026-09-16) logs:
  `read 1 runs (window 30)` and
  `insufficient history: 1 of 10 runs — no flake verdict`. `history summary`
  reports `last 1 runs`. That is the whole denominator.
- The local store never truncates on write (`appendFileSync`, `ndjson-store.ts`
  line 119). Windows are applied only on read (`records.slice(-window)`), so
  retention is not the problem. Persistence is.
- The remote Supabase store does not implement `readAll` (only
  `LocalAsyncAdapter` forwards it, `store.ts`). Any "mine every run" query must
  either use the local store or add a remote query.

### Q4: runners accept an order, mostly at file granularity

This part is from runner documentation, not measured in this repo. Treat it as
an assumption until phase 3's first task proves it on canary's own suite.

- **vitest:** `sequence.sequencer` accepts a custom class whose `sort()` orders
  test **files**. Within-file order stays as declared. Canary's own
  `ts/vitest.config.ts` sets no `sequence` today.
- **pytest:** a `pytest_collection_modifyitems` hook (a small conftest plugin)
  can reorder individual **test items**. That is the finest grain available.
- **Playwright:** there is no supported per-test or per-file ordering hook.
  Files are distributed across workers, and `fullyParallel` removes order
  entirely. The honest consumer is shard or project assignment
  (likeliest-to-fail files grouped into the first shard), not ordering.
- **JUnit-only producers:** the report shape says nothing about the runner, so
  there is no generic consumer. The output can only be a ranked list.

## What this changes in #460's plan

1. The first deliverable is a history-store change: persist history across CI
   runs, and store a repo-relative `test_file`. Without both, a model has
   nothing to learn from and nothing to join.
2. Ordering is file-granular by default (vitest, Playwright shards) with
   test-granular ordering only where the runner allows it (pytest).
3. Cold start is the normal case, not the edge case. Every consumer of canary
   starts where canary itself is today: one run or none.
