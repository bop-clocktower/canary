# katana: a `pending-feature` ledger cause

**Keywords:** canary-katana, quarantine-ledger, cause, pending-feature,
CAUSES_REQUIRING_ISSUE, manhunter, schema-v2

Issue #1330. Brainstormed in autonomous mode (roadmap-fleet lane); the one open
product fork was decided by a human before dispatch (F4 = a).

## Overview and goals

The katana quarantine ledger (schema v2, #771) lets a row assert **why** a test
is out of the suite. The four causes are `flaky`, `product-defect`,
`blocked-data`, `obsolete`
(`agents/skills/claude-code/canary-katana/scripts/ledger.mjs:45`). None of them
fits a **correct test of a feature that has not shipped**, or one that has
shipped behind a flag that is off. Producers file those rows as `blocked-data`
and move the real category into the free-text `reason`. The issue reports 7 of
36 rows in one migration were this case.

That costs two things:

- dashboards and the manhunter quarantine section cannot tell "waiting on test
  data" from "waiting on the feature", and those have different owners and
  different release triggers;
- `blocked-data` reads as environment work, so someone looking for data work
  finds feature work.

Goal: add a fifth cause, `pending-feature`, that **requires an `issue`** (the
feature's ticket), with no change to any existing row.

Out of scope: `blocked-dependency` (decided against, see below), any schema
version bump, any new validation API.

## Decisions made

| #   | Decision                                                                                                                                      | Rationale                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Add **only** `pending-feature`. Do **not** add `blocked-dependency`.                                                                          | Human decision F4 (a), recorded before dispatch. YAGNI: the evidence in #1330 is for the feature case; "waiting on another team's platform" stays `blocked-data` until a separate request shows it needs its own owner.       |
| D2  | `pending-feature` goes in `CAUSES_REQUIRING_ISSUE`.                                                                                           | The test is correct and someone else owns the fix, which is the existing rule for membership (`ledger.mjs:39-43`). An untracked "the feature isn't built" note decays into an unexplained skip just like an untracked defect. |
| D3  | Release rule is unchanged: remove the row when the test passes live, not when the ticket closes.                                              | Same rule as every cause. A closed feature ticket with a still-failing test is exactly the case the ledger exists to keep visible.                                                                                            |
| D4  | Insert it after `blocked-data` in `CAUSES` and in `CAUSES_REQUIRING_ISSUE`: `flaky, product-defect, blocked-data, pending-feature, obsolete`. | Keeps the issue-requiring causes contiguous in `CAUSES`, matching the doc comment that calls them "the middle values". Order is not a contract (nothing indexes by position), only readability.                               |
| D5  | No schema version bump.                                                                                                                       | Additive: every existing row stays valid, `cause` was always a free string on disk, and `load()` normalizes without checking membership.                                                                                      |
| D6  | Keep the TS mirror in `ts/src/analysis/manhunter/ledger.ts` and **guard it with a behavioural parity test** rather than a shared import.      | See approaches below. `ts/` is the published package and does not ship `agents/skills`, so it cannot import `ledger.mjs` at runtime.                                                                                          |

## Approaches considered

**A. Update both lists, add a behavioural parity test (chosen).** Add the cause
to `ledger.mjs` and to the TS mirror. Add a TS test that imports `ledger.mjs`
and, for **every** cause in its `CAUSES`, drives `ledgerSection` with an
issueless row and asserts the "no linked issue" eye fires if and only if the
cause is in katana's `CAUSES_REQUIRING_ISSUE`. Complexity low; no new exports;
the mirror can never silently fall behind again. Risk: the test reaches across
the `ts/` → `agents/` boundary, but only in a test, which other `ts/test` files
already do (`ts/test/batwoman-registry.test.ts:71`).

**B. Update both lists only.** Smallest diff. But the TS mirror already restated
a stale-able list once, and this change is exactly the drift it invites: miss
one file and manhunter stays quiet on an untracked `pending-feature` row.
Rejected: it fixes today and re-arms the trap.

**C. Add a `validateRow()` export to `ledger.mjs` and call it from producers.**
Would give an explicit "rejected" result. But nothing in-repo calls a row
validator today (katana writes causeless rows; producers live outside), so it is
a new public surface with no caller (dead export) to satisfy a test. Rejected
under YAGNI; the existing rejection points are manhunter's eye and
`canary-ci-ready`'s "unlinked quarantine blocks CI-ready" rule, which both key
off `CAUSES_REQUIRING_ISSUE`.

## Technical design

- `agents/skills/claude-code/canary-katana/scripts/ledger.mjs`
  - `CAUSES = ['flaky', 'product-defect', 'blocked-data', 'pending-feature', 'obsolete']`
  - `CAUSES_REQUIRING_ISSUE = ['product-defect', 'blocked-data', 'pending-feature']`
  - doc comment updated: the issue-requiring causes are the ones where the test
    is correct and someone else owns the fix (a defect, data, or an unshipped
    feature).
- `ts/src/analysis/manhunter/ledger.ts`: mirror `CAUSES_REQUIRING_ISSUE`.
- Tests:
  - `agents/skills/test/canary-katana.test.ts`: the hard-coded list assertion is
    updated deliberately; a new case proves a `pending-feature` row with an
    issue persists and supersedes a causeless row, like the other caused rows.
  - `ts/test/manhunter-sections.test.ts`: a `pending-feature` row with no issue
    is flagged; one with an issue is not.
  - new parity test (ts): every katana cause, issueless, is flagged iff katana
    requires an issue for it. Planted positive: run once with the TS mirror
    missing `pending-feature` and record the red.

## Integration points

### Entry Points

None new. Existing: katana ledger constants, manhunter quarantine section.

### Registrations Required

None. No new module (the parity test is a test file, not an entropy entry
point).

### Documentation Updates

- `agents/skills/claude-code/canary-katana/SKILL.md` "Schema v2" section: list
  the five causes, and say which require an issue and why `pending-feature` is
  not `blocked-data`.
- `CHANGELOG.md` `[Unreleased]` → `Added` entry.
- The historical CHANGELOG entry for #771 lists four causes; it is a release
  record and stays as written.

### Architectural Decisions

None (small additive change).

### Knowledge Impact

Domain term: `pending-feature` — a correct test whose behaviour has not shipped
or is flag-disabled; owned by the feature's team; released when it passes live.

## Success criteria

1. When a ledger row has `cause: 'pending-feature'` and an `issue`, the system
   shall treat it as a caused row (persists, supersedes a causeless row for the
   same pair) and manhunter shall raise no "no linked issue" eye for it.
2. If a ledger row has `cause: 'pending-feature'` and an empty `issue`, then
   manhunter shall flag `out as pending-feature with no linked issue`.
3. `CAUSES` contains `pending-feature`; `CAUSES_REQUIRING_ISSUE` contains it.
4. Every existing cause behaves as before (existing tests stay green unchanged
   except the deliberately updated list assertion).
5. If the TS mirror and katana's `CAUSES_REQUIRING_ISSUE` disagree, then the
   parity test shall fail (proved by a planted red).
6. SKILL.md and CHANGELOG name the new cause; no other file restates the list.

## Implementation order

1. Tests first (katana list + pending-feature row; manhunter eye; parity), red.
2. Constants in `ledger.mjs` and the TS mirror, green.
3. Docs: SKILL.md, CHANGELOG.
4. Gates, provenance, PR.
