# Playwright JSON for `canary history record`, and a scored suite runtime

**Keywords:** run-history, playwright-json, vitest-json, duration_ms, ci-ready,
suite-runtime, p95, abstention

Issue: #956. Context: ADR 0026 (trustworthy-gate metric, disclosed partial).

## Overview

`canary history record` detects vitest JSON by its `testResults` array
(`ts/src/history/run-recorder.ts` `detectReportShape`) and refuses anything else
(`ts/src/history/cli.ts:315-320`). A Playwright suite therefore cannot write the
run-history store, so `canary ci-ready`'s `flakiness` check abstains for every
Playwright suite, and `suite-runtime` abstains for everyone
(`ts/src/core/ci-ready.ts` `scoreRuntime` is a hard-coded skip).

Goals:

1. `record` accepts a Playwright `json` reporter file, detected by shape.
2. Playwright's flaky status is recorded as `flaky`, not lost.
3. Per-test and per-run `duration_ms` are persisted for both formats.
4. `ci-ready` scores `suite-runtime` from recorded run durations, and still
   abstains when none exist.

Out of scope: JUnit XML (follow-up), harness perf-baseline runtime mode (the
deterministic CLI keeps the skill's absolute-threshold fallback).

## Decisions made

| Decision                                                                                                                                                                                    | Rationale                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Detect Playwright by a top-level `suites` array (with no `testResults`)                                                                                                                     | Same detect-by-shape rule as vitest; callers never pass a format flag.                                                          |
| Status map: `expected`/`passed` -> passed; `flaky` -> flaky; `skipped`/`pending` -> skipped; `unexpected`/`failed`/`timedOut`/`interrupted` -> failed, unless a later retry passed -> flaky | Mirrors `agents/skills/claude-code/canary-test-reporter/scripts/parse.mjs` `classify`, so two canary readers of one file agree. |
| Test name = suite path `>` spec title (`>` test title if different), plus a `[project]` suffix when `projectName` is set                                                                    | Nested suites collapse into the join key; a project suffix stops the same spec on chromium/webkit merging into one history.     |
| Per-test `duration_ms` = sum of all attempt durations                                                                                                                                       | The time the test really cost the suite, retries included.                                                                      |
| Run `duration_ms` = Playwright `stats.duration` when present, else sum of tests; vitest keeps its sum                                                                                       | `stats.duration` is wall clock, and Playwright runs workers in parallel.                                                        |
| Vitest already writes per-test `duration_ms`; no vitest writer change beyond keeping it                                                                                                     | Found in EXPLORE: `toResultRow` already sets it. The gap was only the reader.                                                   |
| `suite-runtime`: p95 of `duration_ms` over the last 30 runs that carry a positive one; pass < 5 min, warn 5-10 min, fail > 10 min; reason says "vs. absolute threshold"                     | The ci-ready SKILL's documented no-MCP fallback (SKILL.md section 5).                                                           |
| No duration in any run -> `skip`, reason names the store                                                                                                                                    | Legacy records (no `duration_ms`) must load and must not score.                                                                 |
| The flaky=0 note prints only for vitest reports                                                                                                                                             | Playwright does report flakiness; the note would be false there.                                                                |

Approaches considered: (A) import the skill's `parse.mjs` — rejected, skill CLIs
are self-contained and not importable by the engine (run-recorder docstring);
(B) new engine module `ts/src/history/playwright-report.ts` beside the vitest
path — **chosen**; (C) a generic report-adapter registry — rejected, YAGNI with
two formats.

## Technical design

- `ts/src/history/playwright-report.ts` (new): `isPlaywrightReport`,
  `countPlaywrightResults`, `buildRunFromPlaywrightReport(parsed, ctx)` ->
  `BuiltRun`. Small functions (walk suite, map spec, classify) to stay under the
  per-function complexity threshold.
- `run-recorder.ts`: `ReportShape` becomes
  `'vitest' | 'playwright' | 'unknown'`; `countReportResults` and a new
  `buildRunFromReport(shape, parsed, ctx)` dispatch; `validateBuiltRun`
  unchanged and applied to both.
- `cli.ts`: refuse only `unknown`, with a message naming both supported formats;
  dispatch through `buildRunFromReport`; flaky note for vitest only; help text
  and empty-report hint name both reporters.
- `record.ts`: `RunRecord.duration_ms?` and `TestResultRecord.duration_ms?`
  (optional, so legacy lines still type-check and load).
- `core/ci-ready.ts`: `ScoredRun.duration_ms?`; `scoreRuntime(runs, path)`
  computes nearest-rank p95.

## Integration points

- **Entry points:** `canary history record` (accepts a second format);
  `canary ci-ready` (`suite-runtime` can score).
- **Registrations required:** new module under `ts/src/history/**` (existing
  layer); add to both `entropy.entryPoints` arrays only if the entropy check
  flags it.
- **Documentation updates:** README command table, AGENTS.md run-history bullet,
  ci-ready SKILL.md section 5, STRATEGY.md key-metric disclosure (1 of 5 -> 2 of
  5), ADR 0026 context note, CHANGELOG `[Unreleased]`.
- **Architectural decisions:** none new; updates ADR 0026's disclosure facts.
- **Knowledge impact:** Playwright status vocabulary mapping into canary's
  passed/failed/flaky/skipped.

## Success criteria

1. When given a Playwright JSON report with nested suites, `record` appends one
   run whose rows carry suite-path names, mapped statuses and `duration_ms`.
2. When a Playwright test has status `flaky`, or failed then passed on retry,
   the row is `flaky` and the run's `flaky` count includes it.
3. When a report matches neither shape, `record` exits 1 naming vitest and
   Playwright JSON as supported and JUnit XML as not.
4. When a Playwright report carries zero tests, `record` abstains with exit 3.
5. When stored runs carry `duration_ms`, `ci-ready` scores `suite-runtime`
   pass/warn/fail on the p95 against 5/10-minute thresholds.
6. If no stored run carries a duration, `suite-runtime` still reports `skip`,
   and legacy records without durations still load.
7. STRATEGY.md, ADR 0026, SKILL.md and README no longer claim durations are not
   recorded.

## Implementation order

1. Playwright reader and dispatch (tests first).
2. CLI wiring and messages (tests first).
3. `suite-runtime` scoring (tests first).
4. Docs, disclosure, CHANGELOG.
