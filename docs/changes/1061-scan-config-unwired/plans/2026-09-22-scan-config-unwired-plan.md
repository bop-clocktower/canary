# Plan: Record that `scan-config` is deliberately unwired

**Date:** 2026-09-22 **Spec:**
`docs/changes/1061-scan-config-unwired/proposal.md` **Issue:** #1061 **Tasks:**
5 **Time:** ~17 min **Integration Tier:** small **Rigor:** standard (skeleton
pass skipped — 5 tasks, below the 8-task threshold)

## Goal

ADR 0014's `scan-config` Declined row states a current, sourced, falsifiable
reason for staying unwired, tracked by the open issue #1060 instead of the
closed issue #719.

## Observable Truths (Acceptance Criteria)

1. **Ubiquitous.**
   `grep -n "#1060" docs/knowledge/decisions/0014-harness-check-wiring-register.md`
   returns at least one line inside the `scan-config` Declined row.
2. **Unwanted.** If the `scan-config` row cites an issue as its live tracker,
   then it shall not cite #719 (`grep -c "#719" <file>` returns 0 in that row; a
   historical mention is permitted only if explicitly marked closed).
3. **Ubiquitous.** The row states the re-measurement
   `30 INJ-SUS-001 + 7 INJ-SUS-002 (low) + 1 SEC-PTH-001 (medium)` with CLI
   `12.10.0` and commit `76d3f19b`.
4. **Event-driven.** When a reader runs `harness scan-config` on the pinned CLI,
   the Revisit column shall name the 37 + 1 baseline to compare against, so the
   decision can be disproved in one command.
5. **Unwanted.** The row shall not describe `SEC-PTH-001` as accepted,
   known-good or triaged; it states it is untriaged and points at #1060's second
   checkbox.
6. **Ubiquitous.** A `**AMENDED 2026-09-22 (#1061)` bullet exists under
   `## Consequences`.
7. **Ubiquitous.** The header `**Related:**` line names #1060 and #1061.
8. **Ubiquitous.** Four gates green from `ts/`: `build`, `typecheck`,
   `format:check`, `test`.
9. **Ubiquitous.** `npx prettier --check` is clean on the edited Markdown.

## File Map

- MODIFY `docs/knowledge/decisions/0014-harness-check-wiring-register.md` (three
  regions: header `**Related:**` line ~13-19; Declined table `scan-config` row
  line ~122; `## Consequences` bullet list, appended after line ~223)

No other file is created or modified. No code, no workflow, no config.

## Uncertainties

- **[ASSUMPTION]** Amending ADR 0014 satisfies #1061's "record in `docs/`" (spec
  A1). If a reviewer demands a standalone ADR, Tasks 1-3 are rewritten against a
  new `0033-*.md` — the spec's D1 table records why that was rejected.
- **[ASSUMPTION]** `docs/knowledge/decisions/README.md` (stale past 0015) needs
  no change because no new ADR number is allocated (spec Integration Points).
- **[DEFERRABLE]** Exact prose wording of the amended row; prettier reflow of
  the table will change column widths regardless.
- **[NOT A BLOCKER]** No TDD test task appears below. This plan produces zero
  executable code, so there is no behavior to test-first; the acceptance checks
  are `grep` assertions plus the repo's existing four gates, run per task.

## Change Specification (delta against the committed ADR)

- **[MODIFIED]** `scan-config` Declined row — measurement, tracking link,
  revisit condition.
- **[MODIFIED]** header `**Related:**` line — adds #1060, #1061.
- **[ADDED]** one `**AMENDED 2026-09-22 (#1061)**` bullet under
  `## Consequences`.
- **[REMOVED]** `Tracked in #719.` as the row's live tracking link.

## Tasks

### Task 1: Replace the `scan-config` Declined row body

**Depends on:** none **Files:**
`docs/knowledge/decisions/0014-harness-check-wiring-register.md` **Category:**
implementation **Est:** 5 min

1. Open the file and locate the single-line table row beginning
   `| \`scan-config\` |` (currently line 122).
2. Replace the **"Why it stays unwired"** cell with (single line, no embedded
   newlines — it is a Markdown table cell):

   > **Re-measured 2026-09-22 at CLI 12.10.0, `origin/main` `76d3f19b`: 38
   > findings, all the same false-positive class.** The `fileGlob` fix
   > (harness-engineering#1344) reached the pin long ago — `SEC-AGT-007` and
   > `SEC-MCP-002` are both **0** — so half the original revisit condition is
   > met. The residual is not, and it has grown: 30 `INJ-SUS-001` + 7
   > `INJ-SUS-002` (low) matching the pipe characters of ordinary Markdown
   > TABLES in `AGENTS.md`, plus 1 `SEC-PTH-001` (**medium, UNTRIAGED** — nobody
   > has looked at it; it is #1060's second checkbox, and calling it "known"
   > would be the false green this ADR exists to remove) matching a
   > `readFileSync` one-liner quoted as a code SAMPLE. Identical root class:
   > documentation prose read as an executable config directive. Unwireable for
   > a second, independent reason: `scan-config` offers no severity threshold
   > and no ignore mechanism, and its only other flag is `--fix`, which strips
   > matched patterns from files **in place** and would silently edit
   > documentation. Tracked in #1060 (the upstream filing is blocked on
   > work-account push access). The former tracker #719 is CLOSED and is no
   > longer the live link.

3. Replace the **"Revisit when"** cell with:

   > Re-run `harness scan-config --json` on the pinned CLI and compare against
   > the recorded baseline of **37 `INJ-SUS-*` (low) + 1 `SEC-PTH-001`
   > (medium)**. Either disjunct flips the decision: (1) the `INJ-SUS-*` prose
   > findings fall to **0** on a supported pin, i.e. upstream stops reading
   > Markdown prose as a config directive; or (2) `scan-config` grows a severity
   > threshold or an ignore mechanism, so the LOW prose noise can be suppressed
   > **without** `--fix` editing documentation in place. Declined while both are
   > false.

4. Do not touch any other row of the Declined table.
5. **Acceptance check** (all must hold):

   ```bash
   cd /Users/bs/Github/canary-fleet-1061
   F=docs/knowledge/decisions/0014-harness-check-wiring-register.md
   grep -n '`scan-config`' "$F" | head -3          # row still present, still one row
   grep -c '#1060' "$F"                            # >= 1
   grep -n '12.10.0' "$F"                          # re-measurement stamp present
   grep -n '76d3f19b' "$F"                         # commit stamp present
   grep -n 'UNTRIAGED' "$F"                        # D3 satisfied
   grep -n 'Tracked in #719' "$F"                  # must return NOTHING (exit 1)
   ```

   A non-empty result for the last command is a task failure, not a warning.

6. Run: `cd ts && npm run format:check` (fast fail on Markdown damage is done in
   Task 4; this catches nothing here but keeps the per-task gate habit).
7. Do **not** commit. (Autonomous plan-only run; commits are the execution
   phase's job.)

### Task 2: Add the `## Consequences` amendment bullet

**Depends on:** Task 1 **Files:**
`docs/knowledge/decisions/0014-harness-check-wiring-register.md` **Category:**
implementation **Est:** 3 min

1. Locate the `## Consequences` bullet list. Insert a new bullet immediately
   **after** the bullet ending
   `...is indistinguishable from a green result from a gate that cannot fail.`
   and its trailing sentences (currently ends line 232), i.e. as the final
   bullet of the section, matching the existing `**AMENDED <date> (#NNN): ...**`
   house pattern seen at line 187:

   ```markdown
   - **AMENDED 2026-09-22 (#1061): the `scan-config` row was re-sourced; the
     decline itself did not change.** The row had decayed in two ways a reader
     could not detect from inside it: its tracking link, #719, had been CLOSED,
     and its counts were a CLI 12.2.0 measurement (32 findings) that no longer
     matched the tree (38 at CLI 12.10.0, `origin/main` `76d3f19b`). A recorded
     decline whose evidence has expired is the same wallpaper as no record at
     all — worse, because it reads as current. Live tracking moves to #1060, the
     `SEC-PTH-001` medium is now stated as UNTRIAGED rather than merely listed,
     and the revisit condition is restated as a baseline (37 + 1) a reader can
     disprove with one `harness scan-config --json` run. **`scan-config` remains
     unwired**; nothing about the decision changed, only what it is sourced to.
   ```

2. **Acceptance check:**

   ```bash
   cd /Users/bs/Github/canary-fleet-1061
   grep -n 'AMENDED 2026-09-22 (#1061)' \
     docs/knowledge/decisions/0014-harness-check-wiring-register.md   # exactly 1 hit
   awk '/^## Consequences/,/^## Alternatives/' \
     docs/knowledge/decisions/0014-harness-check-wiring-register.md \
     | grep -c 'AMENDED 2026-09-22'                                   # == 1, in-section
   ```

3. Do not commit.

### Task 3: Update the header `**Related:**` line

**Depends on:** Task 2 **Files:**
`docs/knowledge/decisions/0014-harness-check-wiring-register.md` **Category:**
implementation **Est:** 2 min

1. In the `**Status:** accepted **Date:** ... **Related:**` paragraph (lines
   13-19), append to the end of the semicolon-separated list, before the closing
   of the paragraph:

   ```text
   ; #1060 (the live `scan-config` false-positive tracker, superseding the closed
   #719); #1061 (this ADR's 2026-09-22 amendment of the `scan-config` row)
   ```

2. Leave `#717` and `#718` in place — they are this ADR's origin, not stale
   trackers.
3. **Acceptance check:**

   ```bash
   cd /Users/bs/Github/canary-fleet-1061
   sed -n '11,22p' docs/knowledge/decisions/0014-harness-check-wiring-register.md \
     | grep -E '#1060|#1061'    # both appear in the header block
   ```

4. Do not commit.

### Task 4: Normalize with prettier and re-read the rendered table

**Depends on:** Task 3 **Files:**
`docs/knowledge/decisions/0014-harness-check-wiring-register.md` **Category:**
integration **Est:** 3 min

1. Run:

   ```bash
   cd /Users/bs/Github/canary-fleet-1061
   npx prettier --write docs/knowledge/decisions/0014-harness-check-wiring-register.md
   npx prettier --check docs/knowledge/decisions/0014-harness-check-wiring-register.md
   ```

2. **Re-read the file after the rewrite.** Prettier reflows Markdown table
   column widths; confirm the Declined table still has exactly 6 data rows and
   that the `scan-config` row did not absorb a pipe character from the prose (a
   literal `|` inside a cell must be escaped as `\|`). Confirm the row count:

   ```bash
   awk '/^### Declined/,/^#### The `check-operational-drift`/' \
     docs/knowledge/decisions/0014-harness-check-wiring-register.md \
     | grep -c '^| `'          # expect 6
   ```

   A count other than 6 means a cell broke the table — fix before proceeding.

3. **Acceptance check:** `npx prettier --check` exits 0 **and** the row count
   is 6. Note that prettier-clean is not markdownlint-clean; the file carries
   `<!-- markdownlint-disable-file MD025 -->` and no separate markdownlint gate
   is required by this repo's CI.
4. Do not commit.

### Task 5: Four-gate verification from `ts/`

**Depends on:** Task 4 **Files:** none (verification only) **Category:**
integration **Est:** 4 min

1. Gates run from `ts/`, not the repo root — the root `package.json` is a
   vestigial stub. There is no `lint` script; the four gates are build,
   typecheck, format:check, test.

   ```bash
   cd /Users/bs/Github/canary-fleet-1061/ts
   npm run build
   npm run typecheck
   npm run format:check
   npm test
   ```

   Run each as a separate command and read each exit code directly. Do **not**
   pipe them or chain them behind a `|| true`; a swallowed status here is the
   exact false-green shape ADR 0014 exists to remove. Silence from a gate means
   it did not run, not that it passed.

2. Run `harness validate` from the repo root.
3. **Denominator check.** This change touches zero `ts/` source files, so the
   four gates are expected to be green **and to prove nothing about this diff**
   — they are a regression guard against an accidental edit, not evidence the
   ADR is correct. The load-bearing evidence is Tasks 1-4's `grep` assertions.
   Record both; do not report the green gates as verification of the
   documentation change.
4. **Acceptance check:** all four gates exit 0, `harness validate` exits 0, and
   every `grep` assertion from Tasks 1-3 still holds after the prettier rewrite
   (re-run them — prettier reflow can split a line a `grep -n` matched before).

## Traceability

| Observable truth                       | Delivered by |
| -------------------------------------- | ------------ |
| 1 (#1060 present)                      | Task 1       |
| 2 (#719 not the live tracker)          | Task 1       |
| 3 (current measurement + CLI + commit) | Task 1       |
| 4 (runnable revisit condition)         | Task 1       |
| 5 (`SEC-PTH-001` untriaged)            | Task 1       |
| 6 (AMENDED bullet)                     | Task 2       |
| 7 (`**Related:**` line)                | Task 3       |
| 8 (four gates)                         | Task 5       |
| 9 (prettier clean)                     | Task 4       |

## Out of scope (from the spec's non-goals)

- Wiring `scan-config` into any workflow.
- Triaging the 37 `INJ-SUS-*` or the 1 `SEC-PTH-001` (#1060 checkboxes 1-2).
- Filing anything upstream (blocked on work-account push access).
- Touching the other five Declined rows, or `docs/knowledge/decisions/README.md`
  (known stale past 0015, no new number allocated here).

## Execution notes

- Work only in the worktree `/Users/bs/Github/canary-fleet-1061`, branch
  `docs/1061-scan-config-unwired`.
- A PR body for this work must carry `Closes #1061` — and must not place any
  negated closing keyword next to `#1060` or `#719`, since a negated phrase
  still closes the issue on merge.
