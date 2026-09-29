# History writers fill area and failure_category (#1125)

**Issue:** #1125 (G1-G3 from the #610 gap analysis) · **Status:** approved
(autonomous roadmap-fleet lane; forks F1-F4 answered by the maintainer in the
CONFIRM round, the rest self-answered with the recommended option: see
Decisions)

**Keywords:** run-history, history-record, area, failure_category, tags,
critical-areas, failure-categoriser, enricher, abstention

## Overview

`canary history gaps` (#610) proved that a store written by
`canary history record` from a Playwright report carries no `area` and no
`failure_category` on any test (G1, G2), and no `tags` (G3). The format readers
in `ts/src/history/formats/` never set them, so `history flaky`'s area column,
canary-screech's owning area and clusters, and `analyze common-failures` all run
on nothing: every categorised failure lands in one `other` bucket
(`ts/src/analysis/engine.ts:57`, `ts/src/analysis/reports.ts:196`).

This change makes `history record` fill both fields at record time, through an
enricher that lives outside `ts/src/history` and is injected into the recorder.

## Goals

1. `history record` writes `area` on each test whose file maps to an area in
   `.canary/critical-areas.json`.
2. `history record` writes `failure_category` on each failed or flaky test that
   carries error text, using canary's existing failure vocabulary.
3. When `.canary/critical-areas.json` is absent or unreadable, `area` stays
   unset and `record` says so on stderr: an explicit abstention, never a silent
   empty.
4. `tags` stays in the schema, documented as opt-in with no automatic writer.
5. `canary history gaps` reports `flaky-area`, `screech-cluster` and
   `failure-categories` as `fed` on a store recorded from a Playwright report
   with a matching critical-areas file.

## Non-goals

- A `tags` writer (F3). No consumer reads tags; writing them speculatively is
  YAGNI.
- `analyze area-health` (G7). Its engine hard-codes an empty row set, so no
  field a writer fills can light it. It stays documented as structurally dark.
- A config-file path-to-area map, or area from test tags (F1 chose
  critical-areas.json).
- Changing the Vitest or JUnit readers' error handling.

## Decisions

| #   | Decision                   | Choice                                                                                                                                                                                                                                                                                                                                                 | Source                       |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| F1  | `area` source              | Map the test file to an area in `.canary/critical-areas.json`. Absent or unreadable file: `area` unset, reported abstention.                                                                                                                                                                                                                           | maintainer                   |
| F2  | `failure_category` source  | Reuse canary's existing category vocabulary and rules, applied to the error text at record time. No new vocabulary.                                                                                                                                                                                                                                    | maintainer                   |
| F3  | `tags`                     | Keep in the schema; documented opt-in, no automatic writer, a declared gap in the history-gaps guide.                                                                                                                                                                                                                                                  | maintainer                   |
| F4  | Where the code lives       | An enricher outside `ts/src/history`, called by the recorder through an injected function. Net growth inside `ts/src/history` about zero.                                                                                                                                                                                                              | maintainer                   |
| D5  | Which vocabulary           | The analyze engine has no categoriser: it only defaults a missing category to `other`. The one categoriser canary ships is canary-fail-fast's `categorizeFailure` (`schema`, `auth`, `server`, `client`, `timeout`, `network`, `other`), whose fallback is that same `other`. Port it to the engine, pinned by a parity test against the skill script. | lane (recommended)           |
| D6  | Rows without error text    | Leave `failure_category` unset. Writing `other` with no evidence would turn a real gap into a false `fed`.                                                                                                                                                                                                                                             | lane (recommended)           |
| D7  | Flake error text (G8)      | The Playwright reader keeps the error of the last failing attempt for flakes too. Without it, a flake cannot be categorised and `failure-categories` can never be `fed` on a Playwright store (the done-when). A one-expression change inside `formats/`.                                                                                              | lane (required by done-when) |
| D8  | Test-file-to-area matching | Strip the extension and a `.test`/`.spec` marker; candidates are areas with the same basename stem. Rank by shared trailing directory segments, then `risk_score`, then path. The stored value is the area's `path`. No candidate: `area` unset on that test.                                                                                          | lane (recommended)           |
| D9  | Where the file is read     | `<cwd>/.canary/critical-areas.json`, the path every other reader uses (`ts/src/core/inventory-checks.ts:21`). It is parsed with the existing `parseCriticalAreas`.                                                                                                                                                                                     | lane (recommended)           |

### Approaches considered for F4

|             | A) Injected enricher in `ts/src/analysis/enrich/` (chosen)                       | B) Direct import from `record/cli.ts` into a `ts/src/core` enricher           |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| How         | `HistoryDeps.enrichResults?`; the engine registry passes the production enricher | `record/cli.ts` imports `core/…` and calls it unconditionally                 |
| Layering    | analysis may import history types and core; history stays ignorant of it         | core may not import history types, so the enricher re-declares the row shape  |
| Test seam   | Tests of `createHistoryCommand` stay unenriched unless they pass one             | Every `record` test starts reading `.canary/critical-areas.json` from its cwd |
| History LOC | +~6 lines (one optional deps field, one call)                                    | about the same                                                                |
| Fit with F4 | Exactly what was asked                                                           | Contradicts "through an injected function"                                    |

## Technical design

New module `ts/src/analysis/enrich/`:

- `failure-category.ts`: `FAILURE_CATEGORIES` and `categorizeFailure(text)`,
  ported rule for rule from
  `agents/skills/claude-code/canary-fail-fast/scripts/failures.mjs`.
- `area.ts`: `loadAreas(cwd)` reads and parses the critical-areas file once and
  returns the note when it is missing or unusable; `areaFor(testFile, areas)`
  implements D8 over `CriticalArea[]` from `core/inventory-checks.ts`.
- `enrich.ts`: `enrichRecordedResults(results, cwd)` returns
  `{ results, notes }`. It sets `area` where it maps and `failure_category` on
  failed/flaky rows with error text. It is generic over the row shape, so it
  does not import the history schema; that also keeps it under `check-perf`'s
  coupling rule (fan-in plus fan-out over 5 with a ratio over 0.7), which is why
  the file reading lives in `area.ts` rather than here.

Seam inside `ts/src/history` (the only growth there):

- `cli-deps.ts`: `HistoryDeps.enrichResults?(results, cwd)` (optional, no
  default: `history` stays usable without analysis).
- `record/cli.ts`: after `prepareRecordedRun`, when `deps.enrichResults` is set,
  replace `built.results` with the enriched rows and print each note via
  `deps.err` as `note: …`.
- `formats/playwright-report.ts`: D7.

Wiring: `ts/src/commands/engine/cli.ts` passes
`enrichResults: enrichRecordedResults` to `createHistoryCommand`.

## Integration points

- **Entry points:** no new command. `canary history record` gains behaviour.
- **Registrations required:** the new source files go in both
  `entropy.entryPoints` arrays if entropy flags them; an arch allowance for the
  module-size growth, measured empirically.
- **Documentation updates:** `docs/guides/history-gaps.md` (Known gaps G1, G2,
  G3, G8 dispositions); the `history record` section of the history guide or
  README naming the critical-areas input and the abstention note.
- **Architectural decisions:** none rise to an ADR; the seam follows the #988 /
  #1074 registry precedent.
- **Knowledge impact:** `area` means "the critical area the test file maps to",
  and `failure_category` uses the canary-fail-fast vocabulary engine-wide.

## Success criteria

1. When `history record` runs in a directory with a
   `.canary/critical-areas.json` whose areas match the report's test files, the
   stored tests carry the matched area path.
2. When that file is absent, the stored tests carry no area and `record` prints
   a `note:` line naming the file on stderr; the exit code is unchanged.
3. When a failed or flaky test has error text, the stored row carries
   `categorizeFailure(error_text)`; when it has none, no category is written.
4. `categorizeFailure` agrees with the canary-fail-fast script on a shared
   sample set (parity test).
5. A flaky Playwright test stores the error of its last failing attempt.
6. `ts/test/clocktower-e2e.test.ts`'s "reproduces G1 and G2" test is inverted
   into the positive: `flaky-area`, `screech-cluster` and `failure-categories`
   are `fed`, and a companion case without the areas file shows `flaky-area`
   dark.
7. `harness check-arch` reports no new violation and no `ts/src/history`
   module-size threshold violation; four local gates green.

## Implementation order

1. Categoriser port plus parity test.
2. Area matcher plus unit tests.
3. Enricher (reads the file, applies both, emits the abstention note).
4. G8 reader change (test first).
5. Seam in `HistoryDeps` and `record/cli.ts`, wiring in the engine registry.
6. Invert the e2e test; docs; ratchets.
