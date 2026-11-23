# Backfill roadmap rows for every open `route:roadmap` issue (ADR 0043)

**Keywords:** roadmap, External-ID, route:roadmap, intake, ADR 0043,
manage_roadmap, roadmap-pilot

## Overview

ADR 0043
(`docs/knowledge/decisions/0043-route-roadmap-issues-get-a-roadmap-row-at-routing.md`)
gives every `route:roadmap` issue a `docs/roadmap.md` row at routing time,
linked by `External-ID: github:bop-clocktower/canary#N`. The backlog predates
the rule. At 19:19Z on 2026-11-23, 72 issues were open with `route:roadmap` and
55 of them had no row, so `roadmap-pilot`'s scorer could rank only 17 of them.

Goal: the number of open `route:roadmap` issues with no `External-ID` row is 0
at push time.

Out of scope: rows for issues that are not `route:roadmap`; promoting any row
past `backlog`; labelling rows `harness-managed` (the known #1386 gap); the
`scripts/route-queue.mjs` guard (#1438, a separate issue).

## Decisions made

| #   | Decision                                                                                                                                                                                                           | Source                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| D1  | Every new row goes under `## Intake`, appended after the existing Intake rows, `Status: backlog`.                                                                                                                  | Human fork F1 (a)         |
| D2  | Priority by label: any `bug` label gives P2 (`bug` wins over `chore`/`documentation`); otherwise P3 (`enhancement`, `chore`, `documentation`, `github_actions`).                                                   | Human fork F1 (a)         |
| D3  | Field shape and order copy the #1654 rows exactly: Status, Spec `—`, one-sentence Summary, Blockers, Plan `—`, Assignee `—`, Priority, External-ID.                                                                | Human fork F1 (a)         |
| D4  | #1108, #1379 and #1560 name their hold in `Blockers:` (harness#2234; an upstream harness bug; a redesign the human deferred). Every other row has `Blockers: —`.                                                   | Human fork F2 (a)         |
| D5  | Recount right before pushing; add rows for newly routed issues and drop rows for issues closed in the meantime.                                                                                                    | Human fork F3 (a)         |
| D6  | Rows are produced by `manage_roadmap add` with `external_id` (no tracker ticket is created). Only the new row blocks are kept; every re-serialised existing row is reverted. Never `harness roadmap sync --apply`. | Lane constraint, ADR 0043 |
| D7  | #1437 itself is open and `route:roadmap`, so it gets a row too. The done-criterion counts it; it closes with this PR.                                                                                              | Assumption (autonomous)   |

## Technical design

- Data: `gh issue list` on `route:roadmap`, open, `--limit 500` (the default of
  30 under-counts), cross-checked against all open issues filtered on their own
  labels (ADR 0034 warns the `--label` filter can under-report).
- Rows: one `manage_roadmap add` call per missing issue, `milestone: "Intake"`,
  `status: "backlog"`, the D2 priority and the D4 blocker.
- Splice: take `docs/roadmap.md` as it was before the tool ran, and insert the
  tool-written blocks, byte-for-byte, after the last existing Intake row and
  before `## Engine and Platform`.
- Count: AGENTS.md's two `All N rows` sentences restate the linked-row total;
  `ts/test/agents-roadmap-counts.test.ts` pins them to the file.

## Integration points

- **Entry Points:** none (data-only change to `docs/roadmap.md`).
- **Registrations Required:** none.
- **Documentation Updates:** AGENTS.md row count (two sentences).
- **Architectural Decisions:** none; this executes ADR 0043.
- **Knowledge Impact:** none.

## Success criteria

1. When the recount runs at push time,
   `comm -23 <open route:roadmap numbers> <External-ID numbers>` prints nothing.
2. `git diff origin/docs/fc1123b-intake-rows -- docs/roadmap.md` shows only
   added lines, all inside `## Intake`.
3. No row links a closed issue that this PR added.
4. `ts/test/agents-roadmap-counts.test.ts` passes with the new count.
5. `harness validate`, prettier, markdownlint and `scripts/check_doc_fences.mjs`
   pass.

## Implementation order

1. Recount and capture labels.
2. Generate rows with `manage_roadmap add`, splice, revert other hunks.
3. Update the AGENTS.md count; run the count test.
4. Recount, then gates, then push and open the PR stacked on #1654.
