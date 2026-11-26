---
number: 0048
title: Unowned tool-review checks live in the CLI; the contract stays /1
date: 2026-11-25
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/1527
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0048 — Unowned tool-review checks live in the CLI; the contract stays `canary.tool-review/1`

**Status:** accepted **Date:** 2026-11-25 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1527](https://github.com/bop-clocktower/canary/issues/1527) (this decision);
[#1524](https://github.com/bop-clocktower/canary/issues/1524) (canary-blackalice
tracking); ADR 0045 (the `canary.tool-review/1` contract and its versioning
rule); `docs/specs/canary-tool-review-contract.md` ("Not checked by the
validator"); `docs/changes/canary-blackalice/proposal.md` (overlay, coverage
ledger, CLI)

## Context

ADR 0045 shipped `canary.tool-review/1` with five named rules in
`agents/skills/lib/contracts/tool-review.mjs` (`validateToolReview`). Its
Consequences, and the contract doc's "Not checked by the validator" section,
list three properties that nothing checks and that no spec phase owns. Each one
lets a report claim more than it shows:

1. **A finding's `job` names a ledger row.** A finding whose `job` is not the
   `id` of any `kind: job` ledger row validates today. Phase 3's `diff` and
   `file --pick` select findings by id, so a dangling `job` reaches them
   unflagged.
2. **A `file` ref names a line.** The spec's ledger table requires a `mapped`
   row to cite "≥1 `file:line`". `ledgerCompanion` only checks that an evidence
   item of `kind: file` is present (`tool-review.mjs`, `evidenceCompanion`), so
   `"ref": "src/a.ts"` passes.
3. **A `not-applicable` reason is the overlay's own.** The ledger table says a
   `not-applicable` row carries "the overlay's reason". `reasonCompanion` only
   refuses a `null` reason, so any non-null string passes. The overlay
   (`.canary/blackalice.overlay.json`, `disable[].reason`) arrives in phase 2,
   and a standalone validator of a report never sees it.

A fourth item was deferred to phase 3 at the phase 1 review (suggestion hcr-7)
and recorded only in an untracked session file:

**Item 4, a text-input entry point.** `document.mjs`'s `validateText` strips a
BOM, parses, and refuses unparseable JSON before calling `validateDocument`,
whose result carries a `contract` field. `tool-review.mjs` has no text entry
point, and `validateToolReview` returns `{ valid, checked, errors }` with no
`contract`. Without one, the phase 3 CLI would reimplement both.

ADR 0045 fixes the versioning constraint: a minor version only adds optional
fields, so a rule that refuses a report which validates today needs
`canary.tool-review/2`. The contract module ships in the published npm package
(`npm/scripts/build-engine.mjs` stages `agents/skills` into the package, and
`npm/package.json` `files` lists `agents/`), so changing what `/1` accepts
changes it for every installed copy, not only for this repo.

The CLI already holds the right seams. Per the proposal's CLI table, `record`
moves a ledger row out of `pending` and refuses a missing reason or evidence,
and `report build` assembles the ledger and findings and validates the report it
writes. `plan --overlay` is where the overlay enters the run.

## Decision

1. **Items 1–3 are CLI checks, not validator rules.** The `canary-blackalice`
   CLI enforces them. `canary.tool-review/1` and `validateToolReview` are not
   changed: no rule is added, and no report that validates today stops
   validating.
   - **A finding's `job` names a `kind: job` ledger row.** `report build`
     refuses (exit 1) any finding whose non-null `job` is not the `id` of a
     `kind: job` row in the ledger it assembles. A finding with `job: null`
     (quality only) is unaffected. `record` never sees findings, so this check
     lives in `report build` only.
   - **A `file` ref names a `file:line`.** `record --evidence` refuses a `file`
     item whose `ref` names no line, and `report build` refuses the same in the
     report it assembles. The exact `ref` grammar (see Assumptions) is the phase
     3 spec's to pin.
   - **A `not-applicable` reason is the overlay's own.** `record` refuses a
     `not-applicable` row whose `reason` is not the `reason` of the overlay
     `disable` entry for that `id`, and `report build` re-checks every
     `not-applicable` row against the same overlay.
2. **`report build` is the backstop.** Because it validates the report it
   assembles, a hand-edited ledger or findings file that skips `record` is still
   refused there. This is the same argument ADR 0045 used for companions,
   applied at the CLI instead of the contract.
3. **`validateToolReviewText` is an additive entry point, with no version
   change.** It is exported from `tool-review.mjs`. It strips a leading BOM,
   parses, and refuses unparseable or empty input with a `$`-path error and
   `checked: 0`, mirroring `document.mjs`'s `validateText`. Its result carries a
   `contract` field alongside `valid`, `checked` and `errors`, matching
   `validateDocument`'s shape: the contract string when the parsed document
   claims `canary.tool-review/1`, otherwise `null`. It lands with phase 3, so
   the phase 3 CLI calls it rather than reimplementing parsing. Adding an export
   accepts and refuses exactly the documents `validateToolReview` does, so it
   needs no `/2`.

### Assumptions made

These are routine defaults taken in autonomous mode. Each is the phase 3 spec's
to confirm or override.

- **The `file:line` grammar** is a path, a colon and a positive line number,
  optionally followed by `-<end>` for a range (`src/a.ts:42`, `src/a.ts:42-48`).
  It applies to every `kind: file` evidence item, on ledger rows and on
  findings, because a finding citing a bare file overclaims the same way a
  `mapped` row does.
- **The overlay check is exact string equality** with the `disable[].reason` of
  the same `id`. No reason vocabulary is needed: the overlay already carries one
  reason per disabled id (proposal, "Tool overlay").
- **A `not-applicable` row the overlay does not disable is refused.** That
  includes every `kind: surface` row, since the overlay disables job ids only. A
  surface that does not apply is `not-assessed` with a reason. The proposal's
  ledger table defines `not-applicable` as "Disabled by the overlay".
- **An unreachable overlay is a refusal, not a skip.** If `record` or
  `report build` meets a `not-applicable` row and cannot load the overlay the
  run was planned from, it refuses (exit 1) and says it could not verify the
  reason. How the CLI locates that overlay (a path recorded at `plan`, checked
  against `overlay_sha`, or an `--overlay` flag on `report build`, whose
  proposal signature has none today) is the phase 3 spec's to decide.
- **`validateToolReview`'s own return shape stays as it is.** The `contract`
  field is added to `validateToolReviewText`'s result. Adding it to
  `validateToolReview` too would also be additive, but this ADR keeps the
  existing entry point untouched.
- **No discovery, analysis or proposal files** were written under
  `docs/architecture/`. The forks were answered at the fleet's CONFIRM step, and
  this record carries the options.

## Consequences

### Positive

- `canary.tool-review/1` keeps meaning one thing across every installed copy of
  the package. No report that validates today is refused by a validator upgrade,
  so ADR 0045's "tightening needs `/2`" rule is honoured rather than argued
  around.
- Item 3 is checked where the overlay is actually available. A standalone
  validator holding only a report could not check it at all.
- The phase 3 CLI gets one text entry point instead of a second copy of BOM
  stripping and parse refusal.
- The hcr-7 deferral is now recorded in an ADR rather than only in a session
  file, and all four items have an owner (phase 3).

### Negative

- **The CLI is stricter than the contract.** A report that validates under `/1`
  may still be refused by `report build`. A consumer that validates with
  `validateToolReview` alone gets weaker guarantees than one that built the
  report with the CLI. Mitigation: document it in the contract doc (below), and
  name each CLI-only check in `report build`'s refusal message so the gap is
  visible rather than silent.
- **A report written by another producer skips these checks.** Only reports
  built by this CLI carry them. Mitigation: none in `/1`. If a second producer
  appears, promoting the checks into `canary.tool-review/2` is the path, and
  this ADR is the record of why they started in the CLI.

### Neutral

- **Docs this makes wrong.** The contract doc's "Not checked by the validator"
  section says "Nothing checks these, and the spec assigns them to no phase". It
  must instead point to where each check now lives: item 1 at `report build`,
  items 2 and 3 at `record` and `report build`. The phase 3 change updates it
  when the checks ship. The proposal's CLI table and acceptance criteria do not
  yet name these refusals, so the phase 3 spec adds them.
- **The phase 3 spec owns the implementation**: the CLI checks, their tests,
  `validateToolReviewText` and its tests. This ADR changes no code.
- `document.mjs`, `validate.mjs`, `rules.mjs` and the tool-review schema are not
  touched.

## Alternatives Considered

- **(B) Make items 1–3 validator rules in a new `canary.tool-review/2`.**
  Rejected. It cuts a new major before any `/1` report exists and before any
  second producer needs it, and item 3 still could not be a validator rule,
  because the validator never holds the overlay. Items 1 and 2 alone would split
  the checks across two places for no gain.
- **(C) Tighten `/1` in place, on the argument that no report exists yet.**
  Rejected. It contradicts ADR 0045's consequence that a rule refusing a report
  which validates today is a new major. The validator also ships in the
  published npm package, so "no report exists yet" cannot be verified for every
  installed copy, and the precedent would weaken the versioning rule for every
  later contract.
- **For item 4, leave text parsing to the CLI.** Rejected. The CLI would
  reimplement `validateText`'s BOM stripping and parse refusal, the two copies
  would drift, and any other reader of a tool-review file would need a third.

## Action Items

- [ ] Phase 3 spec: add the three CLI refusals to the CLI table and acceptance
      criteria, pin the `file:line` grammar and the overlay lookup — owner:
      phase 3 author — by: phase 3 planning.
- [ ] Phase 3: implement the checks in `record` / `report build` and
      `validateToolReviewText`, test first — owner: phase 3 author — by: phase 3
      merge.
- [ ] Phase 3: rewrite the contract doc's "Not checked by the validator" section
      to point to where each check lives — owner: phase 3 author — by: phase 3
      merge.
