# Plan: Playwright history record + scored suite runtime (#956)

Spec: `docs/changes/playwright-history-record/proposal.md`

All gates run from `ts/`: `npm run build`, `npm run typecheck`,
`npm run format:check`, `npm test`.

## Task 1 — Playwright reader (TDD)

- Test first, `ts/test/history-record-playwright.test.ts`: detect shape; nested
  suites flatten to `a > b > spec` names; status map (expected, unexpected,
  flaky, skipped, timedOut, retry-then-pass); per-test duration is the sum of
  attempts; run duration from `stats.duration`; project suffix; zero tests
  counts 0.
- Implement `ts/src/history/playwright-report.ts`; extend `ReportShape`,
  `countReportResults`, add `buildRunFromReport` in `run-recorder.ts`.

## Task 2 — CLI wiring (TDD)

- Tests: end-to-end `history record pw.json --suite web` appends a run that
  `history summary` reads; unknown shape message names both formats; flaky note
  absent for Playwright; empty Playwright report exits 3.
- Update `ts/src/history/cli.ts` (dispatch, messages, help).
- Update the existing unknown-shape test's expected wording.

## Task 3 — suite-runtime scoring (TDD)

- Tests in `ts/test/ci-ready-cli.test.ts`: durations under 5 min pass; p95 in
  5-10 min warns; over 10 min fails; no durations skip (replaces the "always
  skips" test); only the last 30 runs count.
- Implement in `ts/src/core/ci-ready.ts`; add optional `duration_ms` to
  `ts/src/history/record.ts` types.

## Task 4 — Docs and disclosure

- STRATEGY.md key metric: 2 of 5 checks scored; name only the inventory gap.
- ADR 0026: dated update note (the decision stands; facts changed).
- canary-ci-ready SKILL.md section 5, README table, AGENTS.md history bullet,
  module docstrings, CHANGELOG `[Unreleased]` (JUnit XML noted as follow-up).

## Task 5 — Verify

- Four gates; entropy/arch check for the new module; scan diff for consumer
  identifiers; provenance JSON; `harness waypoint record-provenance`.
