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
  both", "no score key anywhere" and "at least one piece of evidence" cannot be
  stated there.

## Decision

1. **A standalone contract, `canary.tool-review/1`.** Its schema is
   `agents/skills/lib/contracts/tool-review.v1.schema.json`. It is **validated
   by its own entry point**, `tool-review.mjs` (`validateToolReview`), following
   `critical-areas.mjs`. `document.mjs`, `validate.mjs` and `rules.mjs` are not
   changed. A test pins that the shared validator refuses this contract string.
2. **Naming extends ADR 0035 D3.** Layer contracts stay
   `canary.<layer>/<major>`. Standalone contracts use `canary.<name>/<major>`,
   and `<name>` may contain hyphens. The schema's `const` is the whole check, so
   a different major is refused.
3. **Ledger first.** Every merged job and every discovered result surface is a
   ledger row in exactly one of four states: `walked`, `mapped`, `not-assessed`
   or `not-applicable`. `pending` is a working-file state that a report never
   carries, and the schema refuses it. The Markdown render opens with the ledger
   counts, before any finding.
4. **Run-level abstentions are a required list.** `not_assessed` holds what the
   run could not exercise at all. An absent list is refused and `[]` means none,
   so "nothing was skipped" is a statement, not a missing key. Per-row
   abstentions stay in the ledger.
5. **Three named rules, in the entry point.** `jobOrQuality`, `noCompositeScore`
   (the keys `score`, `overall`, `composite` and `rating`, refused by key
   presence on the report and every finding) and `evidenceRequired`. They live
   in `tool-review.mjs`, as `critical-areas.mjs` keeps its own rules, because
   they belong to this contract alone and `rules.mjs` serves the layer family.
6. **No composite score** (spec D8). This applies ADR 0036 to tool reviews. It
   needs no new principle, only the rule that enforces it.

## Consequences

- A tool review can be validated and diffed run over run, and a report that
  hides a persona behind a score, or a finding with nothing to point at, cannot
  validate.
- The four layer-family modules are untouched, so this decision cannot regress
  `canary.run/1`, `canary.assessment/1` or `canary.site/1`.
- **The validator does not check per-row companions** (a walked row's
  screenshot, a not-assessed row's reason) or the zero-walked abstention. These
  are producer obligations of the `canary-blackalice` CLI, which enforces them
  when a row is recorded and when a report is built. A hand-assembled report
  could carry a `walked` row without evidence and still validate. Making those
  contract rules is additive (a minor version) if a second producer appears.
- `reviewed_at` is checked against the timestamp pattern only. The `real-dates`
  rule is not applied, so a month 13 is accepted.
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
  sits under `check-perf`'s 300-line threshold. Three more rules would cross it.
- **A score out of 10.** Rejected by spec D8 and ADR 0036.
