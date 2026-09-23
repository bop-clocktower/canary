# Pin the generator-stamped dead-link count

Refs #838. This is a **partial slice**: the root defect is upstream in
`harness-engineering`'s `generate-agent-definitions`, and no commit in this repo
can repair it. What this change buys is a tripwire, not a fix.

## Overview and goals

`scripts/check_doc_links.mjs` splits its output into two buckets:

- the **gated** bucket — this repo's own prose, currently 0 dead links across
  381 scanned Markdown files, exit 0 if and only if it stays empty;
- the **reported-not-gated** bucket — files carrying a generator's "Do not edit"
  stamp, currently **30 dead links across 38 files**, printed and counted but
  never gated, because the links are the generator's output.

That separation is correct and load-bearing (`scripts/check_doc_links.mjs`
`GENERATED_RE` and its comment block): the exclusion keys off the stamp rather
than a path list, so the day one of those trees becomes hand-authored it
re-enters the gate by itself. The denominator is never shrunk.

The gap is that the reported bucket exits 0 unconditionally. The count can grow
— a regenerated agent tree, a new generator template, a new broken reference —
and nothing anywhere fails. Issue #838's own "Suggested handling" names the
remedy: assert the count does not grow.

**Goal:** a test that fails when the generator-stamped dead-link count moves,
and that refuses to read a zero denominator as a pass.

**Out of scope:** fixing the generator (upstream, human action), excluding any
path, raising any ceiling, or reducing what is scanned.

## Decisions made

### D1 — Pin with exact equality, not a ceiling

`toBe(30)`, not `toBeLessThanOrEqual(30)`.

A ceiling only fails upward. A shrink means something real happened — the
upstream fix landed, or a generated tree was dropped — and the pin should then
be updated deliberately, with the issue revisited, rather than silently
absorbing the change. Exact equality also makes the zero case fail
automatically, which a ceiling would pass.

The failure message distinguishes the two directions explicitly, so a shrink
does not read as a regression: growth is "the generator got worse", shrink is
"good news — re-measure, update the pin, and check whether #838 can close".

### D2 — Assert the denominator separately and first

`generatedFiles` is asserted `> 0` before the count is compared. Exact equality
already catches zero, but a bare `expected 30, got 0` reads as a count change
when the real event is that the scan found no generator-stamped files at all —
an abstention. A named assertion ahead of it fails with the right diagnosis.

### D3 — Pin `generatedFindings`, not `filesScanned`

The scanned-file total is environment-dependent: it counts untracked-but-not-
ignored Markdown, so a scratch file in the working tree moves it (measured: 382
in a checkout holding one untracked doc, 381 in a clean worktree — same commit).
`generatedFiles` and `generatedFindings` come only from committed, stamped trees
and are stable. The test asserts `filesScanned > 0` as a sanity floor and pins
neither it nor a hard file total.

### D4 — Extend `ts/test/doc-links.test.ts`, add no new module

The file already carries a `describe('the repository itself')` block that runs
the real script against the real repo. The pin belongs there. A new test module
would trip the entropy ratchet's entry-point bookkeeping for no benefit.

### D5 — The issue body's numbers are stale; the measurement is not

Issue #838 quotes 36 generator-stamped files and 255 scanned. Re-measured at
`7995370b`: **38** and **381**. The dead-link count, 30, is unchanged. The pin
is set from the re-measurement.

## Technical design

One `it` inside `describe('the repository itself')` in
`ts/test/doc-links.test.ts`, using the existing `exec(['--json'])` +
`parseContract` helpers from `doc-links-testkit.ts` — the same path the adjacent
gated-bucket test already uses, so no new plumbing.

Assertions, in order:

1. `generatedFiles` > 0 — denominator guard (D2).
2. `generatedFindings.length` === `GENERATED_DEAD_LINKS` (30) — the pin (D1),
   with a message naming both directions.

The pinned number lives in a named constant with a comment stating what it is,
when it was measured, and what to do in each failure direction.

## Integration points

- **Entry points:** none. One test case in an existing spec file.
- **Registrations required:** none. No new module, no entropy entry point, no
  new script, no workflow change.
- **Documentation updates:** none — the constant documents itself and #838
  remains the tracker.
- **Architectural decisions:** none rise to an ADR. ADR 0012 §7 (do not shrink
  the denominator) already governs; this change obeys it rather than amending
  it.
- **Knowledge impact:** none.

## Success criteria

- When the generator-stamped dead-link count grows, the test fails.
- When it shrinks, the test fails with a message that reads as news, not as a
  regression.
- When zero generator-stamped files are scanned, the test fails on the
  denominator assertion, not on the count.
- Proven by planting a positive: perturbing the expected count makes the test
  red; reverting makes it green.
- `check_doc_links` behaviour is unchanged — no path excluded, no ceiling
  raised, no file dropped from the scan.

## Implementation order

1. Write the failing assertion (planted positive) and confirm red.
2. Set the pin to the re-measured 30 and confirm green.
3. Four gates from `ts/`, `check-deps` from the repo root.
