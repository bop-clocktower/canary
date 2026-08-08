# Roadmap priority and the one-line field contract

## Overview

`docs/roadmap.md` cannot answer "what should I work on next", and cannot be
safely written by the tooling that owns it. Two independent defects:

1. **No priority signal.** 36 of 38 rows read `Status: backlog`. Ranking the
   backlog today means re-deriving it by hand from issue bodies every time.
2. **The file has drifted out of its own schema contract.** Field values must be
   a single line. Prettier's `proseWrap: "always"` wraps them, and
   `docs/roadmap.md` is not in `.prettierignore`, so multi-line summaries are
   invisible past their first line to every harness roadmap command.

A third, smaller gap: 10 open issues have no roadmap row, so the roadmap is not
a complete picture of committed work.

### Goals

- A roadmap row states its own priority, validated by the existing schema.
- The one-line contract is mechanically enforced, not remembered.
- Roadmap coverage of non-bug work is complete and its denominator is stated.

### Non-goals

- Pushing priority to GitHub (labels or bodies). `--apply` replaces issue bodies
  and there is no upstream opt-out (`scripts/roadmap-sync.mjs`), so the roadmap
  stays the priority system of record for now.
- Migrating row prose into issues. That is the "roadmap as thin index" end state
  — structurally correct, a one-way door, and its own decision.
- Fixing the four gate-integrity bugs themselves (#481 is tracked here as a row;
  #587, #590, #626 stay bugs).

## Decisions made

**D1 — Priority lives in `docs/roadmap.md`, not GitHub.** `Priority` is already
a first-class field in the harness roadmap schema; this repo has simply never
populated it. Verified empirically: a `P2` injected into a copy survived
`harness roadmap shard` + `regen`, and an invalid value hard-fails with
`Valid priorities: P0, P1, P2, P3`. So the field is validated on read. Pushing
it to the tracker would require `roadmap sync --apply`, which replaces issue
bodies — rejected under the same reasoning as #595.

**D2 — The contract gets an ignore rule AND a test, not just a rule.** Adding
`docs/roadmap.md` to `.prettierignore` stops the cause. It does not stop a
hand-wrapped edit, a different formatter, or an editor's reflow. The invariant
is cheap to assert directly, so it is asserted directly.

**D3 — This is not an upstream bug.** The one-line-per-field contract is
documented in the roadmap's own header comment. Harness reads exactly what the
schema specifies; our file drifted. What IS worth reporting upstream is the
asymmetry: harness errors loudly on an invalid `Priority` value but silently
keeps a wrapped field's first line. A contract violation should fail to parse or
warn, never silently discard. Filed as a separate upstream report, not a blocker
for this change.

**D4 — Bugs do not get roadmap rows; work does.** Of the 10 issues with no row,
3 carry the `bug` label (#587, #590, #626) and stay bugs — they get fixed and
closed, not tracked as plan. The other 7 are committed work and get rows:
`#390`, `#479`, `#481`, `#487`, `#488`, `#504`, `#544`. This makes the labelled
count an intentional number rather than an accident, which is what the
denominator check in `scripts/roadmap-denominator-check.mjs` reports on.

**D5 — Seed priorities from blast radius, and record the basis.** Gate integrity
outranks consumer-facing correctness, which outranks enablers, which outrank
net-new. The seeding is a starting position, not a permanent ranking; what
matters is that the field exists and is populated, so future changes are an edit
rather than a re-derivation.

## Technical design

### Priority scale

Fixed by the upstream schema — `P0 | P1 | P2 | P3`. No local scale to invent.

| Value | Meaning                                         | Seeded from                                    |
| ----- | ----------------------------------------------- | ---------------------------------------------- |
| `P0`  | The gate is wrong or about to be                | #481, #544                                     |
| `P1`  | A user hits it directly; or in flight           | #504, #538, #523, #522, #603                   |
| `P2`  | Enabler — makes a cluster of other work cheaper | #479, #550, #462, #487, #486, #390, #488, #601 |
| `P3`  | Net-new capability, no dependency pressure      | the 31 skill and engine rows                   |

### The one-line field invariant

New test, `ts/test/roadmap-field-contract.test.ts`, offline, parses
`docs/roadmap.md` as text:

- Every line matching `^- \*\*(\w[\w -]*):\*\*` is a field.
- The line after a field line is either another field, a blank line, a heading,
  or a comment — never a continuation.
- Denominator assertion: the file yields > 0 fields, so a parse that matched
  nothing fails rather than passing vacuously.

`.prettierignore` gains `docs/roadmap.md` and `docs/roadmap.d/`. Repairing the
existing wrapped summaries is mechanical — join continuation lines back onto
their field line. No content is dropped; the file gets longer per line, not
shorter.

### The 7 new rows

Added via `manage_roadmap` action `add` (or hand-written to the same shape),
each carrying `Status`, `Priority`, `Summary`, and an `External-ID` linking the
existing issue. Each issue also gets the `harness-managed` label so
`roadmap sync` can see it — the label is what decides visibility (#595).

Expected end state: 45 linked rows; 46 of 49 open issues labelled; the 3
remaining are the `bug`-labelled ones, by decision D4.

## Integration points

**Entry points.** No new CLI command, MCP tool, or skill. One new test file; one
new `.prettierignore` entry; content edits to `docs/roadmap.md`.

**Registrations required.** The 7 issues need the `harness-managed` label
applied via `gh`. No barrel export or route registration.

**Documentation updates.** `AGENTS.md` — the roadmap section gains the field
contract (why `docs/roadmap.md` is prettier-exempt, and that a wrapped field is
silently truncated by harness) and the priority scale with its meanings. Without
that note the `.prettierignore` entry reads as an arbitrary exclusion and gets
removed by a future cleanup.

**Architectural decisions.** None warrant a standalone ADR. D1 and D4 are
recorded here and referenced from `AGENTS.md`; neither changes system structure.

**Knowledge impact.** One durable fact worth capturing: a machine-managed
markdown file under a prose formatter is a data-loss hazard, and the failure is
silent in both directions — the file looks maintained, the tool reports no
error. That generalises past the roadmap to any schema-bearing doc in the repo.

## Success criteria

1. `ts/test/roadmap-field-contract.test.ts` fails when any field in
   `docs/roadmap.md` is wrapped across lines, and reports a non-zero field
   count.
2. `npx prettier --check docs/roadmap.md` no longer reports the file (ignored).
3. Every row in `docs/roadmap.md` carries a `Priority` of `P0`–`P3`; zero rows
   read `—`.
4. `harness roadmap shard` on a copy round-trips with no byte loss in any
   `Summary` field.
5. `node scripts/roadmap-denominator-check.mjs` reports 45 linked rows and 46/49
   labelled, exit 0.
6. The four gates pass: build, typecheck, format, test.

## Implementation order

1. **Contract first.** `.prettierignore` entry, then the invariant test (red —
   the file is currently wrapped), then repair the wrapped summaries to green.
   Doing this before anything else means every later edit lands under the guard.
2. **Populate `Priority`** on the 38 existing rows.
3. **Add the 7 rows** and apply `harness-managed` to their issues.
4. **Docs** — `AGENTS.md` field contract and priority scale.
5. **Verify** — success criteria 1-6, including the round-trip byte check.

Phase 1 is independently shippable and carries all of the risk; phases 2-4 are
content edits under its guard.

**Keywords:** roadmap, priority, schema-contract, prose-wrap, data-loss,
denominator, harness-managed, roadmap-sync
