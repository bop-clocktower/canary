---
number: 0045
title: canary.tool-review/1 is a ledger-first review contract
date: 2026-10-28
status: accepted
tier: medium
source: https://github.com/bop-clocktower/canary/issues/1524
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0045 — `canary.tool-review/1` is a ledger-first review contract

**Status:** accepted **Date:** 2026-10-28 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#1524](https://github.com/bop-clocktower/canary/issues/1524) (this decision);
`docs/changes/canary-blackalice/proposal.md` (D8, D9, D11); ADR 0035 (the
contract family, its keyword subset, and D3's naming); ADR 0036 (no composite
health score); ADR 0009 (exit 3 reserved for "abstained")

## Context

`canary-blackalice` reviews a QA tool from the seats of the six personas who use
it, and writes down what it found. A review has the failure mode it looks for in
others. A report that lists findings without saying how much of the tool it
examined reads as "everything else is fine", which is the false green
STRATEGY.md says canary exists to prevent ("degrades loudly when the evidence
tier drops rather than silently guessing").

The report needs a versioned, validated shape so that two reviews of the same
tool can be diffed. The existing family does not fit it as-is:

- `document.mjs` dispatches on `CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/` over
  a fixed `LAYERS = ['run', 'assessment', 'site']`. The regex admits no hyphen.
  Routing a fourth contract through it would widen a validator three contracts
  and their producers depend on.
- The schemas must stay inside ADR 0035's audited keyword subset: no `oneOf`, no
  `additionalProperties`, no `minItems`. "A finding names a job, a quality or
  both", "no score key on the report or a finding", "at least one piece of
  evidence", "each ledger state carries its companion" and "no two findings
  share an id" cannot be stated there.

## Decision

1. **A standalone contract, `canary.tool-review/1`.** Its schema is
   `agents/skills/lib/contracts/tool-review.v1.schema.json`. It is **validated
   by its own entry point**, `tool-review.mjs` (`validateToolReview`), following
   `critical-areas.mjs`. `validate.mjs`, `rules.mjs` and `document.mjs`'s
   dispatch (`CONTRACT_RE`, `LAYERS`) are not changed. The shared validator
   refuses this contract string with a message naming `tool-review.mjs`, and a
   test pins that refusal.
2. **Naming extends ADR 0035 D3.** Layer contracts stay
   `canary.<layer>/<major>`. Standalone contracts use `canary.<name>/<major>`,
   and `<name>` may contain hyphens. The schema's `const` is the whole check, so
   a different major is refused.
3. **Ledger first.** Every merged job and every discovered result surface is a
   ledger row in exactly one of four states: `walked`, `mapped`, `not-assessed`
   or `not-applicable`. `pending` is a working-file state that a report never
   carries, and the schema refuses it. The Markdown render (phase 3) must open
   with the ledger counts, before any finding.
4. **Run-level abstentions are a required list.** `not_assessed` holds what the
   run could not exercise at all. An absent list is refused and `[]` means none,
   so "nothing was skipped" is a statement, not a missing key. Per-row
   abstentions stay in the ledger.
5. **Five named rules, in the entry point.** `jobOrQuality`, `noCompositeScore`
   (the keys `score`, `overall`, `composite` and `rating`, refused by key
   presence on the report and every finding), `evidenceRequired`,
   `ledgerCompanion` (each ledger state carries the companion the spec's ledger
   table requires: a `walked` row a snapshot or screenshot, a `mapped` row a
   file, a `not-assessed` or `not-applicable` row a reason) and `idsUnique` (no
   two findings, and no two ledger rows, share an `id`). They live in
   `tool-review.mjs`, as `critical-areas.mjs` keeps its own rules, because they
   belong to this contract alone and `rules.mjs` serves the layer family.
   `reviewed_at` also gets the shared `real-dates` check, `isTimestamp` from
   `field-checks.mjs`, as every other canary timestamp does.
6. **No composite score** (spec D8). This applies ADR 0036 to tool reviews. It
   needs no new principle, only the rule that enforces it.

## Consequences

- A tool review can be validated and diffed run over run. A report or finding
  carrying a `score`, `overall`, `composite` or `rating` key cannot validate,
  and neither can a finding with nothing to point at. The rule covers those four
  exact keys on the report root and on findings only; on a ledger row or on
  `tool` they are tolerated unknown fields.
- The layer family's schemas, rules and dispatch are unchanged. `document.mjs`
  gained one refusal message, for this contract string only, so `canary.run/1`,
  `canary.assessment/1` and `canary.site/1` validate exactly as before.
- **Tightening this contract needs `canary.tool-review/2`.** A minor version
  only adds optional fields (the contract doc's Conventions, after ADR 0035 D3),
  so a rule that refuses a report which validates today is a new major, not a
  minor. That is why `ledgerCompanion` and `idsUnique` are in `/1`, before any
  report exists, rather than left to the CLI.
- **Where companions are enforced.** Every validation of a report enforces them,
  because they are contract rules. In the spec, `record` refuses a missing
  reason or evidence when a row is recorded, and `report build` validates the
  report it assembles (proposal.md, CLI). So a hand-edited ledger file that
  drops a companion is refused at `report build` too.
- **The zero-walked abstention stays a CLI concern.** A report with no `walked`
  row validates. `report build` prints the abstention line, writes no report and
  exits 0, or 3 under `--strict` (spec phase 3).
- **Not checked by the validator:** that a finding's `job` names a ledger row,
  that a `file` ref names a line, and that a `not-applicable` reason is the
  overlay's own.
- `reviewed_at` gets the same `real-dates` check as every other canary timestamp
  (`isTimestamp` from `field-checks.mjs`, #1225), so a month 13 or a 2025-02-29
  is refused. Phase 3 orders reviews by this field.
- Two validator entry points now exist for contracts with a `contract` field. A
  reader picks one by contract string; `document.mjs` stays the entry point for
  the layer family only.

## Alternatives Considered

- **Route through `document.mjs`** by widening `CONTRACT_RE` and `LAYERS`.
  Rejected: it changes a validator other teams' producers depend on, in order to
  add a contract none of them produce.
- **`oneOf` / `additionalProperties` in the schema.** Rejected: outside ADR
  0035's audited subset, which refuses at load any keyword it does not enforce.
- **The rules in `rules.mjs`**, as the spec's file layout first said. Rejected:
  that module is the layer family's, dispatched by layer, and at 258 lines it
  sits under `check-perf`'s 300-line threshold. Five more rules would cross it.
- **A score out of 10.** Rejected by spec D8 and ADR 0036.
- **Leave per-row companions and id uniqueness to the CLI.** Rejected: a
  hand-edited ledger file reaches `report build`, and adding the rules once
  reports exist would need `canary.tool-review/2`.
