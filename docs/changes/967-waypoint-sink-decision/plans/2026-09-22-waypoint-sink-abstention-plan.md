# Plan: Record the waypoint-sink abstention

**Date:** 2026-09-22 **Issue:** #967 **Spec:**
`docs/changes/967-waypoint-sink-decision/proposal.md` **Tasks:** 4 **Time:** ~14
min **Integration Tier:** small **Rigor:** standard

## Goal

Record, as ADR 0033, that canary deliberately does not configure `waypoint.sink`
— so the `record-provenance` no-op is legible as an abstention with a named
revisit condition rather than a broken seam.

## Observable Truths (Acceptance Criteria)

1. `docs/knowledge/decisions/0033-waypoint-sink-abstention.md` exists with YAML
   frontmatter carrying `number: 0033` and a `title:`, `status: accepted`,
   `date: 2026-09-22`.
2. The ADR quotes the verbatim command output "Waypoint sink not configured
   (harness.config.json `waypoint.sink`); nothing recorded." and states the exit
   code is 0.
3. The ADR states the no-op is a deliberate abstention, not a failure.
4. The ADR names the revisit condition: a reachable Waypoint outpost with a
   project id, plus a `PNYON_WAYPOINT_INGEST_TOKEN` supplied from a secret store
   and never committed.
5. The ADR names `docs/changes/<slug>/provenance.json` as the only record of
   fleet activity.
6. `docs/knowledge/decisions/README.md` has exactly one index row for 0033 whose
   status column reads `accepted`.
7. When the repo is scanned, `ts/test/adr-index.test.ts` passes (no missing, no
   orphaned, no wrongStatus entries).
8. `harness.config.json` contains no `waypoint` key (unchanged from HEAD).
9. `npx markdownlint-cli2` reports no errors on the two changed markdown files,
   and `npx prettier --check` reports them formatted.
10. From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
    and `npm test` all exit 0.

## Constraints

- **No source changes.** Documentation only; no file under `ts/src/` is touched.
- **`harness.config.json` must NOT gain a `waypoint` key.** Adding one is the
  decision being declined (D1).
- **Do not raise any ratchet baseline** (entropy, perf, architecture). A
  docs-only change should move none of them; if one moves, that is a finding to
  report, not a number to edit.
- **Do not touch the pre-existing uncommitted files** `.codex/config.toml`,
  `.codex/hooks.json`, `CANARY_ARCHITECTURE_DIAGRAM.md`. They belong to another
  session. Stage files by explicit path, never `git add -A`.
- **No AGENTS.md change** (D2 — the ADR is the single source).
- Branch: `docs/967-waypoint-sink-decision` in the isolated worktree.

## Uncertainties

- **[ASSUMPTION]** 0033 is the next free ADR number. The highest file and index
  row on this branch is 0032. If a concurrent session lands 0033 first, Task 1
  renumbers to the next free slot and Task 2 follows. Verified at the start of
  Task 1.
- **[ASSUMPTION]** The ADR body uses `<!-- markdownlint-disable-file MD025 -->`,
  matching ADR 0028 and every recent sibling. The README's Format section still
  says `disable-next-line`; the shipped files are the operative contract. Do not
  "fix" the README prose in this change — that is out of scope.
- **[DEFERRABLE]** Exact prose wording of the ADR sections.

## File Map

- CREATE `docs/knowledge/decisions/0033-waypoint-sink-abstention.md`
- MODIFY `docs/knowledge/decisions/README.md` (append one index row)
- CREATE
  `docs/changes/967-waypoint-sink-decision/plans/2026-09-22-waypoint-sink-abstention-plan.md`
  (this file)

Nothing else. In particular: `harness.config.json` — unchanged.

## Skeleton

_Not produced — task count (4) is below the standard-mode threshold of 8._

## Tasks

### Task 1: Author ADR 0033

**Depends on:** none **Files:**
`docs/knowledge/decisions/0033-waypoint-sink-abstention.md`

1. Confirm the number is free:

   ```bash
   ls docs/knowledge/decisions/ | grep -E '^00(3[0-9])'
   ```

   Expect `0030`, `0031`, `0032` and no `0033`. If `0033` exists, use the next
   free 4-digit number throughout this plan.

2. Read the model file for shape (frontmatter keys, bold status line, section
   order): `docs/knowledge/decisions/0028-flair-scope-cascade-provenance.md`.

3. Create `docs/knowledge/decisions/0033-waypoint-sink-abstention.md` with this
   exact skeleton, filling the prose from the spec's D1–D4:

   ```markdown
   ---
   number: 0033
   title: The waypoint sink stays unconfigured, and the abstention is recorded
   date: 2026-09-22
   status: accepted
   tier: small
   source: docs/changes/967-waypoint-sink-decision/proposal.md
   ---

   <!-- markdownlint-disable-file MD025 -->

   # ADR 0033 — The waypoint sink stays unconfigured, and the abstention is recorded

   **Status:** accepted **Date:** 2026-09-22 **Deciders:** Bri Stevenski
   **Related:** docs/changes/967-waypoint-sink-decision/proposal.md (D1–D4);
   issue #967; ADR 0009 (exit 3 reserved for "abstained"); ADR 0026 (a partial
   metric kept and disclosed)

   ## Context

   <!-- Every roadmap-fleet lane ends with
        `harness waypoint record-provenance docs/changes/<slug>/provenance.json`,
        and every run returns, verbatim:
        "Waypoint sink not configured (harness.config.json `waypoint.sink`);
        nothing recorded." and exits 0.
        Why the key is absent rather than broken: `waypoint` is a tolerant
        passthrough on the shared config loader, so it is NOT one of the keys
        silently stripped by the schema — it would work if set.
        What setting it would buy: transport accepts exactly one value,
        "spool", which appends JSONL to a repo-local `.harness/spool/`.
        Onward delivery needs a separate `ship` block with an outpost id, a
        project id, and a PNYON_WAYPOINT_INGEST_TOKEN. Canary has none. -->

   ## Decision

   <!-- MUST state, explicitly:
        1. `harness waypoint record-provenance` returns
           "Waypoint sink not configured (harness.config.json `waypoint.sink`);
           nothing recorded." and exits 0 — and this stays true.
        2. That silence is a DELIBERATE ABSTENTION, not a failure and not an
           unfinished wire. Nothing is broken; the key is absent on purpose.
        3. Configuring `spool` today would produce a growing local spool that
           is never shipped and never read — more moving parts than the
           abstention, with the same information reaching anybody.
        4. This ADR is the only record (D2): no AGENTS.md note, because a
           second copy would drift. -->

   ## Consequences

   <!-- MUST state that fleet provenance therefore lives ONLY as the committed
        `docs/changes/<slug>/provenance.json` artifacts, and that those files
        are consequently THE record of fleet activity — a future reader looking
        for fleet history looks there, not in a telemetry backend.
        Also: a reader who greps "Waypoint sink not configured" lands here in
        one hop; the abstention is disclosed, which is what makes it a resolved
        decision rather than an open defect. -->

   ## Alternatives Considered

   <!-- A) Configure `waypoint.sink.transport: "spool"` now — rejected: an
           unread, unshipped local spool.
        B) Configure sink + ship — rejected: no outpost, no project id, no
           token; a committed token is disqualifying.
        C) An AGENTS.md note instead of an ADR — rejected (D2): the abstention
           is met in fleet lane output, not while reading AGENTS.md, and a
           second copy drifts.
        D) Leave it undocumented — rejected: that is the defect #967 reports.
        Revisit condition (D4): a reachable Waypoint outpost with a project id,
        and a PNYON_WAYPOINT_INGEST_TOKEN delivered from a secret store, never
        committed. Absent all three, reopening this is re-litigating D1 with no
        new evidence. -->
   ```

   Replace each HTML comment with real prose. No comment markers remain in the
   committed file.

4. Verify the required content is present:

   ```bash
   grep -c 'Waypoint sink not configured' docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   grep -c 'PNYON_WAYPOINT_INGEST_TOKEN' docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   grep -c 'provenance.json' docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   grep -c '<!--' docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   ```

   Expect the first three to be `>= 1` and the last to be exactly `1` (the
   markdownlint directive only).

5. Verify the frontmatter parses the way the index test reads it:

   ```bash
   head -8 docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   ```

   `number:`, `title:`, and `status: accepted` must each be on their own line.

6. Verify no config drift was introduced:

   ```bash
   git diff --stat harness.config.json
   ```

   Expect empty output.

### Task 2: Add the 0033 index row to the decisions README

**Depends on:** Task 1 **Files:** `docs/knowledge/decisions/README.md`

1. Append one row to the end of the Index table, immediately after the 0032 row:

   ```markdown
   | [0033](0033-waypoint-sink-abstention.md) | The waypoint sink stays
   unconfigured, and the abstention is recorded | accepted |
   ```

   Column padding does not need to be hand-aligned — prettier reflows the table
   in Task 3. The status cell must read exactly `accepted`, matching the
   frontmatter, or `ts/test/adr-index.test.ts` fails on `wrongStatus`.

2. Verify exactly one row exists for 0033:

   ```bash
   grep -c '^| \[0033\]' docs/knowledge/decisions/README.md
   ```

   Expect `1`. A duplicate row fails the test's `duplicate index row` assertion.

3. Verify the link target resolves:

   ```bash
   ls docs/knowledge/decisions/0033-waypoint-sink-abstention.md
   ```

4. Run the drift gate on its own for a fast signal:

   ```bash
   cd ts && npx vitest run test/adr-index.test.ts
   ```

   Expect 2 passing tests, including the zero-denominator guard.

### Task 3: Format and lint the changed markdown

**Depends on:** Task 2 **Files:**
`docs/knowledge/decisions/0033-waypoint-sink-abstention.md`,
`docs/knowledge/decisions/README.md`, this plan file

These are two separate gates. Prettier-clean is not markdownlint-clean; run both
and read both.

1. Format:

   ```bash
   npx prettier --write \
     docs/knowledge/decisions/0033-waypoint-sink-abstention.md \
     docs/knowledge/decisions/README.md \
     docs/changes/967-waypoint-sink-decision/plans/2026-09-22-waypoint-sink-abstention-plan.md
   ```

2. Lint:

   ```bash
   npx markdownlint-cli2 \
     docs/knowledge/decisions/0033-waypoint-sink-abstention.md \
     docs/knowledge/decisions/README.md \
     docs/changes/967-waypoint-sink-decision/plans/2026-09-22-waypoint-sink-abstention-plan.md
   ```

   Expect `Summary: 0 issues in 0 files`. **Check the denominator on the
   `Linting: N file(s)` line above it** — it must equal the number of files
   passed. The summary's "0 files" counts only files _with_ issues and is not
   the denominator; `Linting: 0 files` is an abstention (a bad glob), not a
   pass. Fix any MD025/MD013/MD034 findings in the files themselves; never
   weaken `.markdownlint.json` (the `protect-config.js` hook forbids it).

3. Re-verify formatting after any lint fix:

   ```bash
   npx prettier --check docs/knowledge/decisions/0033-waypoint-sink-abstention.md docs/knowledge/decisions/README.md
   ```

4. Re-run the index test, since prettier reflows the table and the row regex is
   whitespace-sensitive:

   ```bash
   cd ts && npx vitest run test/adr-index.test.ts
   ```

### Task 4: Run the four gates

**Depends on:** Task 3 **Files:** none (verification only)

There is no `lint` script in `ts/`. The four gates are build, typecheck,
format:check, and test — all run from `ts/`, not the repo root.

1. ```bash
   cd ts && npm run build
   ```

2. ```bash
   cd ts && npm run typecheck
   ```

3. ```bash
   cd ts && npm run format:check
   ```

4. ```bash
   cd ts && npm test
   ```

   Read the summary line, not just the exit code; do not read `$?` after a pipe.
   Expect a non-zero test count with 0 failures.

5. Confirm the working tree contains only the intended changes and that the
   three foreign uncommitted files are untouched:

   ```bash
   git status --porcelain
   ```

   Expect `docs/knowledge/decisions/0033-waypoint-sink-abstention.md` (new),
   `docs/knowledge/decisions/README.md` (modified), and the plan file (new),
   plus the pre-existing `.codex/config.toml`, `.codex/hooks.json`, and
   `CANARY_ARCHITECTURE_DIAGRAM.md` in exactly the state they started in:

   ```bash
   git diff --stat .codex/config.toml
   ```

   Expect empty output — this session must not have modified it.

6. Confirm no ratchet baseline moved:

   ```bash
   git diff --stat -- '*baselines.json' harness.config.json
   ```

   Expect empty output. If a ratchet went red on a docs-only change, report it
   as a finding — do not edit the baseline.

## Risks

| Risk                                                                                                                                           | Likelihood | Mitigation                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontmatter missing `number` or `title` — the knowledge ingestor **skips the file silently**, no error, and the ADR never reaches the graph.   | Medium     | Task 1 step 5 inspects the frontmatter directly. Post-merge, `harness knowledge-pipeline` must show the `decisions` count move.            |
| Prettier reflows the README index table and breaks `ts/test/adr-index.test.ts`'s row regex.                                                    | Medium     | Task 3 step 4 re-runs the index test **after** prettier, not before.                                                                       |
| Index status cell disagrees with frontmatter status (e.g. `Accepted` vs `accepted`) — the test compares them literally.                        | Low        | Both are written as lowercase `accepted`; Task 2 states this explicitly and Task 2 step 4 checks it.                                       |
| Markdownlint MD025: frontmatter `title:` is treated as a second H1.                                                                            | Medium     | The `<!-- markdownlint-disable-file MD025 -->` directive is in the Task 1 skeleton, above the `# ADR 0033` heading.                        |
| HTML comment scaffolding left in the committed ADR, shipping an unfinished-looking record.                                                     | Medium     | Task 1 step 4 asserts exactly one `<!--` remains (the lint directive).                                                                     |
| 0033 collides with a concurrently landed ADR from another session.                                                                             | Low        | Task 1 step 1 checks before writing; `git fetch origin` before opening the PR and re-run the index test if `main` moved.                   |
| `git add -A` sweeps the three foreign uncommitted files into the commit.                                                                       | Medium     | Stage by explicit path only. Task 4 step 5 verifies they are unchanged.                                                                    |
| A ratchet (entropy / perf / architecture) goes red on a docs-only change because the floor comes from the merge base.                          | Low        | Task 4 step 6 checks no baseline moved. If a ratchet is red, re-measure the merged tree and use the `refresh-baseline` label — never edit. |
| The README Format section says `disable-next-line` while every shipped ADR uses `disable-file`, so a reviewer flags the ADR as non-conforming. | Low        | Noted under Uncertainties: the shipped files are the operative contract. Out of scope to fix the README prose here; file it if it matters. |
| The ADR reads as a to-do ("we should wire this later") rather than a decision, which re-opens D1 by tone.                                      | Medium     | Observable truths 3 and 4 require explicit abstention language plus a concrete, checkable revisit condition.                               |

## Out of Scope

- Configuring `waypoint.sink` in any form.
- Any AGENTS.md change (D2).
- Correcting the README Format section's `disable-next-line` wording.
- Any change under `ts/src/`.
