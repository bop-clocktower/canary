# Record that `scan-config` is deliberately unwired

**Issue:** #1061 (local half of the closed #719) **Route:** feature
**Severity:** LOW — documentation of a decision, not a code change.

## Overview

`harness scan-config` runs in no workflow. Issue #1061 asks that the repo record
that this is a decision rather than an oversight, name the reason, link the
upstream issue tracking the false positives, and state a falsifiable condition
under which the check gets wired.

### Goals

1. A reader who wonders "why is `scan-config` not in CI?" finds a current,
   sourced answer without re-measuring.
2. The answer is falsifiable: it names the observable event that flips the
   decision, so it cannot decay into a permanent excuse.
3. The record cites live evidence (#1060) rather than the closed #719.

### Non-goals (YAGNI / scope discipline)

- **Not** wiring `scan-config` into any workflow.
- **Not** triaging the 37 `INJ-SUS-*` findings or the 1 `SEC-PTH-001`. That is
  #1060's first two checkboxes and stays there.
- **Not** filing anything upstream (blocked on work-account push access, #1060).
- **Not** touching the other declined rows in the register.

## Evidence — verified in this worktree, not inherited from the brief

Measured in a clean worktree at `origin/main` `76d3f19b`, harness CLI 12.10.0:

```console
$ grep -rn "scan-config" .github/
(no matches — exit 1)

$ harness scan-config --json \
  | jq -r '[..|objects|select(has("ruleId"))]
           | group_by(.ruleId)[] | "\(.[0].ruleId) \(.[0].severity) x\(length)"'
INJ-SUS-001 low x30
INJ-SUS-002 low x7
SEC-PTH-001 medium x1
```

This reproduces #1060 exactly: 37 `INJ-SUS-*` (low) plus 1 `SEC-PTH-001`
(medium). So the premise holds — the command is genuinely unwired, and the
finding profile is the one #1060 documents.

**A record already exists and is stale.**
`docs/knowledge/decisions/0014-harness-check-wiring-register.md:122` carries a
`scan-config` row in its **Declined** table. It says "Tracked in #719" — an
issue that is now CLOSED — and reports a CLI 12.2.0 measurement (32 findings: 31
`INJ-SUS-*` + 1 `SEC-PTH-001`). The counts have moved (37 + 1) and the tracking
issue has moved (#1060). So #1061's first checkbox is not "write a record from
nothing"; it is "the record exists, points at a dead issue, and quotes stale
numbers".

## Decisions made

### D1 — Amend ADR 0014 rather than write a new document

|          | A) Amend ADR 0014's Declined row                                                        | B) New standalone ADR 0033                                                   | C) New plain doc under `docs/`     |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| **Pros** | Single source; the register is already the canonical answer to "why is check X unwired" | Full narrative room                                                          | Cheapest to write                  |
| **Cons** | Edits an accepted ADR                                                                   | **Two records of one decision that drift** — exactly the failure #1061 names | Third location, least discoverable |
| **Risk** | Low — the ADR already has an in-place amendment convention                              | Medium                                                                       | Medium                             |

**Chosen: A.** ADR 0014's entire purpose is "every harness check is wired or its
decline is recorded"; `scan-config` is one of its own rows. A second document
would mean a reader who finds the register gets the stale answer, which is worse
than today. The ADR already amends itself in place — `## Consequences` carries
`**AMENDED 2026-09-10 (#850): ...**` bullets — so this follows an established
house pattern rather than inventing one.

_Evidence:_ `docs/knowledge/decisions/0014-harness-check-wiring-register.md:113`
(the Declined table), `:188` (the AMENDED-bullet convention).

### D2 — The revisit condition must be checkable from a command's output

The existing row's condition ("Prose is excluded from the
`INJ-SUS-*`/`SEC-PTH-*` denominator upstream, or the command grows a severity
threshold") is already falsifiable in shape, but it is not anchored to anything
a reader can run. The amendment restates it as a condition with a named check:
re-run `scan-config` on the pinned CLI and compare against the recorded baseline
of 37 + 1.

Two disjuncts, either of which flips the decision:

1. The `INJ-SUS-*` prose findings fall to zero on a supported CLI pin — i.e.
   upstream stops reading Markdown prose as a config directive; or
2. `scan-config` grows a severity threshold or an ignore mechanism, so the LOW
   prose noise can be suppressed **without** `--fix` editing documentation in
   place.

Wiring stays declined while both are false. The record names the number to beat,
so a future reader can disprove it in one command.

### D3 — Do not record the SEC-PTH-001 medium as triaged

The register must not imply the medium has been looked at. The amendment states
plainly that it is untriaged and points at #1060's second checkbox. An
unexamined medium described as "known" is the same false-green shape this ADR
exists to remove.

## Technical design

One file changes:
`docs/knowledge/decisions/0014-harness-check-wiring-register.md`.

1. **Declined table, `scan-config` row** — replace the stale body:
   - re-measurement stamped at CLI 12.10.0 / `origin/main` `76d3f19b`;
   - counts 30 `INJ-SUS-001` + 7 `INJ-SUS-002` (low) + 1 `SEC-PTH-001` (medium);
   - tracking link moved from the closed #719 to the open #1060, noting the
     upstream filing is blocked on work-account push access;
   - the second, independent reason kept: no severity threshold, no ignore
     mechanism, and `--fix` edits files in place;
   - the `SEC-PTH-001` explicitly marked untriaged (D3).
   - Revisit column restated per D2, naming the 37 + 1 baseline to beat.
2. **`## Consequences`** — add one `**AMENDED 2026-09-22 (#1061): ...**` bullet
   recording that the row was re-sourced, why (the tracking issue closed and the
   counts moved), and that the decline itself did not change.
3. **Frontmatter / `**Related:**` line** — add #1060 and #1061 so the ADR's own
   header points at the live issues.

No code, no workflow, no config. Markdown only.

## Integration points

- **Entry Points:** None. No CLI surface, no MCP tool, no workflow step.
- **Registrations Required:** None. ADR 0014 already exists and is already
  indexed; no new number is allocated, so the known-stale
  `docs/knowledge/decisions/README.md` index (stale past 0015) needs no change
  and is not touched.
- **Documentation Updates:** the ADR itself is the documentation update.
- **Architectural Decisions:** None standalone — this amends an existing ADR
  rather than raising a new one (D1).
- **Knowledge Impact:** Keeps the "unwired check → recorded decline" relation
  accurate for `scan-config`; prevents the register from asserting a dead issue
  as the tracking link.

## Success criteria

1. `grep -n "#1060" docs/knowledge/decisions/0014-harness-check-wiring-register.md`
   returns at least one line in the `scan-config` row. **Observable.**
2. The `scan-config` row no longer cites #719 as its live tracker.
3. The row states the current measurement (37 `INJ-SUS-*` low + 1 `SEC-PTH-001`
   medium) with its CLI version and commit.
4. The Revisit column names a condition a reader can test by re-running
   `harness scan-config` and comparing to the recorded baseline.
5. The `SEC-PTH-001` is described as untriaged, not as accepted.
6. A `**AMENDED 2026-09-22 (#1061)**` bullet exists under `## Consequences`.
7. Four gates green from `ts/`: build, typecheck, format:check, test.
8. `npx prettier --check` clean on the edited Markdown.

## Implementation order

1. Amend the Declined row.
2. Add the Consequences amendment bullet and update the `**Related:**` line.
3. `npx prettier --write` the edited file; re-read the rendered table.
4. Run the four gates from `ts/`.
5. Commit, push, open a PR with `Closes #1061`.

## Assumptions (autonomous mode — no human present to answer EVALUATE)

- **A1:** Amending ADR 0014 satisfies "record in `docs/`". The issue says
  `docs/`, not "a new file"; ADR 0014 lives under `docs/knowledge/decisions/`
  and is the register for exactly this class of decision.
- **A2:** `docs/adr/` does not exist in this repo — the ADR convention is
  `docs/knowledge/decisions/NNNN-slug.md`. Verified by directory listing.
- **A3:** Both of #1061's checkboxes are in scope and both are completed by this
  change, so the PR closes the issue (`Closes #1061`).
- **A4:** The two #1060 checkboxes (confirm the FPs, triage the medium) and the
  upstream filing remain open and are deliberately untouched.

**Keywords:** scan-config, unwired-check, ADR-0014, false-positive, INJ-SUS-001,
SEC-PTH-001, revisit-condition, decision-register
