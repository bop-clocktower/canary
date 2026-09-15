# Plan: JUnit XML ingestion for `canary history record` (#963)

## Design (brainstorming outcome, autonomous lane, recommended defaults)

| Option                                                        | Pros                                       | Cons                                            | Chosen |
| ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- | ------ |
| A) Move in-repo XML primitives to `util`, small JUnit scanner | No dependency; layer-legal; reuses scanner | Hand-rolled tag scan to maintain                | yes    |
| B) Add a third-party XML parser (npm)                         | Full XML fidelity                          | New dependency; needs review sign-off           | no     |
| C) Duplicate `xml.ts` inside `history/formats`                | No cross-layer move                        | Two copies of a security-relevant scanner drift | no     |

## Mapping

| JUnit                                           | History record                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `classname` + `name`                            | `test_name` = `classname::name` (bare `name` when no classname)                        |
| `file` attr                                     | `test_file` (else empty)                                                               |
| `<failure>` / `<error>`                         | `failed`                                                                               |
| `<skipped>`                                     | `skipped`                                                                              |
| none of the above                               | `passed`                                                                               |
| `time` seconds (fractional/absent)              | `duration_ms` = round(s x 1000), absent -> 0                                           |
| `flakyFailure`/`flakyError`, no final failure   | `flaky`                                                                                |
| `rerunFailure`/`rerunError`, no final failure   | `flaky` (with a final failure: `failed`)                                               |
| same `classname::name` repeated                 | one row: last attempt's status, `flaky` if an earlier attempt failed; durations summed |
| first suite `timestamp` (zone-less read as UTC) | run `timestamp` (else now)                                                             |
| zero testcases                                  | abstain, exit 3 (same path as vitest/Playwright)                                       |

## Tasks

1. Move `ts/src/guardian/diff-coverage/formats/xml.ts` -> `ts/src/util/xml.ts`;
   update cobertura + test imports.
2. Synthetic fixtures `ts/test/fixtures/junit/{pytest,surefire}-style.xml`;
   failing tests `ts/test/history-record-junit.test.ts` + CLI cases in
   `history-record.test.ts`.
3. `ts/src/history/formats/junit-report.ts` (`isJunitReport`,
   `countJunitResults`, `readJunitReport`), small functions.
4. Wire `detectReportShape` / `buildRunFromReport` / `countReportResults`; CLI
   reads XML as text after `isWellFormedXml`.
5. Update CLI messages, README, AGENTS.md, ci-ready SKILL.md, CHANGELOG.
6. Gates (build, typecheck, format:check, test), `harness check-arch`,
   `harness check-deps`.
