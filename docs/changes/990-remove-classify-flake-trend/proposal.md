# Remove `classifyFlakeTrend` as dead code

**Issue:** #990 (follow-up to #604 decision H4, gap G5) **Route:** feature
(roadmap-fleet build lane) **Keywords:** dead-code, flakiness, history-detector,
trend-classification, dead-export-ratchet, #604-H4, abstention

## Overview

`classifyFlakeTrend` in `ts/src/history/detector.ts` classifies a time-ordered
list of per-run flake rates as `rising` / `falling` / `stable` by comparing the
mean of the window's second half against its first, against a fixed
`TREND_THRESHOLD` of 0.1. It has no production caller. The #604 spec recorded
this as gap **G5** and decision **H4** deliberately deferred it so the flakiness
work could ship. Phase 1 (#987) and Phase 2 (PR #989) are both merged, and
neither wires it.

This change deletes the function, the `FlakeTrend` enum, the `TREND_THRESHOLD`
constant, and the function's `describe` block in `detector.test.ts`.

## Decisions made

| ID  | Decision                                           | Rationale                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Delete** rather than wire or keep-with-a-comment | Decided by the human, not defaulted. Issue #990 offered three options; the human chose option 2. Recorded here and in `provenance.json` so a reviewer can see the option was resolved.                                                                                                                                    |
| D2  | Delete `FlakeTrend` and `TREND_THRESHOLD` too      | Both existed solely to serve `classifyFlakeTrend` (`detector.ts:10-16`); leaving them behind would move the dead code rather than remove it.                                                                                                                                                                              |
| D3  | Leave the rest of the flaky envelope untouched     | `flake_rate_pct`, `flip_rate_pct`, sufficiency and disclosure fields are Phase 1/2 production surface with real callers. Out of scope.                                                                                                                                                                                    |
| D4  | Leave historical documents unedited                | `docs/changes/604-flakiness-detector/proposal.md`, `docs/plans/2026-07-22-ts-migration-history-plan.md`, `docs/ideation/*` and `docs/roadmap.md` mention the symbol as a record of past reasoning, not as a promise of a live capability. Rewriting history would falsify the #604 gap analysis this issue descends from. |
| D5  | Closing keyword is `Closes #990`                   | The delete branch fully satisfies the issue's stated acceptance ("it and its test are gone"). `Refs` would strand the row.                                                                                                                                                                                                |

## Technical design

Deleted from `ts/src/history/detector.ts`:

- `export enum FlakeTrend` (Rising / Falling / Stable)
- `const TREND_THRESHOLD = 0.1`
- `export function classifyFlakeTrend(rates: number[]): FlakeTrend`

Deleted from `ts/src/history/detector.test.ts`:

- `classifyFlakeTrend` and `FlakeTrend` from the import list
- the `describe('classifyFlakeTrend', ...)` block (3 cases)

Surviving in `detector.ts`: `RegressionResult`, `BAD_STATUSES`,
`detectRegressions` — all of which have production callers and keep their tests.
The module's `TimelineEntry` import is still needed by `detectRegressions`.

## Integration points

- **Entry points:** None. `classifyFlakeTrend` was reachable only from its own
  test; no CLI command, MCP tool, skill, report or JSON schema field consumes it
  or the `rising`/`falling`/`stable` vocabulary.
- **Registrations required:** None. Verified that no barrel export, harness
  `entryPoints` array, or dead-export baseline names `detector.ts`'s trend
  symbols.
- **Documentation updates:** None (decision D4). No `docs/` page and no
  `SKILL.md` promises trend classification as a current capability.
- **Architectural decisions:** None — small change, no ADR.
- **Knowledge impact:** Closes gap G5 from the #604 gap analysis; decision H4 is
  now resolved in the delete direction.

## Success criteria

1. `git grep -n classifyFlakeTrend -- ts/` returns nothing.
2. `git grep -n FlakeTrend -- ts/` returns nothing.
3. `detectRegressions` and its tests are unchanged.
4. The four gates (`build`, `typecheck`, `format:check`, `test`) pass from
   `ts/`. **These are weak evidence by construction** — green after removing
   code mostly proves that nothing referenced it, which is what the grep already
   established. The grep is the load-bearing evidence; the gates only rule out a
   compile-time or formatting regression.
5. The dead-export ratchet and `harness.config.json` are no worse.

## Implementation order

Single phase: delete the symbol and its test block, run the gates, commit.
