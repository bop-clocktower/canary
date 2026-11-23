# Plan: backfill Intake rows for open `route:roadmap` issues (#1437)

**Spec:** `docs/changes/fc1123b-1437-backfill-intake-rows/proposal.md`
**Phase:** 1 of 1 (complexity: low) **Integration tier:** small

## Tasks

1. **Recount.** List open `route:roadmap` issues (`--limit 500`), cross-check
   against all open issues filtered on their labels, and `comm -23` the numbers
   against the `External-ID` numbers in `docs/roadmap.md`. Save the original
   roadmap. Files: none.
2. **Generate rows.** One `manage_roadmap add` per missing issue
   (`milestone: Intake`, `status: backlog`, `external_id`, a short heading, a
   one-sentence Summary from the issue, `blocked_by` only for #1108, #1379 and
   #1560). Files: `docs/roadmap.md`.
3. **Set Priority.** `manage_roadmap` has no priority parameter and writes
   `Priority: —`. Set each new row's Priority line by the label rule (any `bug`
   label gives P2, else P3), matching the #1654 rows. Files: `docs/roadmap.md`.
4. **Splice.** Rebuild `docs/roadmap.md` as the saved original plus the new
   blocks, ascending by issue number, after the last existing Intake row. Check
   that `git diff` holds only added lines inside `## Intake`. Files:
   `docs/roadmap.md`.
5. **Red, then green, on the count test.** Run
   `ts/test/agents-roadmap-counts.test.ts` and record it failing on the stale
   `18`; update both AGENTS.md `All N rows` sentences; rerun green. Files:
   `AGENTS.md`.
6. **Gates.** build, typecheck, format:check, full `npm test` (from `ts/`);
   prettier and markdownlint on changed markdown;
   `scripts/check_doc_fences.mjs`; `harness validate`;
   `scripts/roadmap-denominator-check.mjs` (report only); perf ratchet as CI
   runs it.
7. **Recount before push** (fork F3): add rows for newly routed issues, drop
   rows for issues closed meanwhile; repeat 4-6 if anything changed.
8. **Provenance, push, PR** stacked on #1654 with `Closes #1437` only.

## Checkpoints

- After task 4: diff is additions-only inside `## Intake`.
- After task 7: the missing count is 0.
