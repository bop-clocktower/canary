---
number: 0034
title: A route:* label family is canary's half of the issue-fleet contract
date: 2026-09-22
status: accepted
tier: small
source: docs/changes/1071-durable-route-persistence/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0034 — A `route:*` label family is canary's half of the issue-fleet contract

**Status:** accepted **Date:** 2026-09-22 **Deciders:** Bri Stevenski
**Related:** [#1071](https://github.com/bop-clocktower/canary/issues/1071);
[#886](https://github.com/bop-clocktower/canary/issues/886) (upstream enum,
`Intense-Visions/harness-engineering#2183`);
`docs/changes/1071-durable-route-persistence/proposal.md` (D1–D6); ADR 0009
(exit 3 reserved for "abstained")

## Context

`issue-fleet` computes a route for every triaged issue — the downstream fleet
that should own it — and then discards it. The routed queue is the skill's
terminal artifact and the contract every downstream fleet consumes, yet it
survived only as session transcript.

The obvious place to fix this is the skill. That place is not available. The
skill is vendored under
`~/.claude/plugins/marketplaces/harness/agents/skills/claude-code/issue-fleet/`
and is overwritten by every harness CLI release, so any patch there is erased on
the next `mise` upgrade. `grep -rln "issue-fleet"` across this repo returns
exactly one match — a `provenance.json` — confirming canary owns no
implementation to patch.

What canary _does_ own is the **write end**: a route has to be recorded
somewhere, and the somewhere is this repository's GitHub label vocabulary. The
upstream fix widens the route _enum_ (the set of legal values); it cannot supply
the place to put one. #886 closes when that enum lands, and this gap would have
closed with it, unfixed and unrecorded.

## Decision

**A `route:*` label family**, one label per destination fleet plus
`route:unroutable`, mirroring the existing `fleet:claimed` pattern. Canary ships
the vocabulary and the tooling that creates, validates, reads back, and reports
on it (`scripts/lib/route-labels.mjs`, `scripts/route-queue.mjs`).

Four sub-decisions carry the weight:

1. **Labels, not a structured comment block.** A comment survives vocabulary
   churn and carries a timestamp natively, but is not queryable. Shipping _both_
   was considered and rejected outright: two write paths that can disagree is a
   new false-green surface, which is the failure class this change exists to
   close.

2. **The destination enum is derived from the installed fleet roster**, minus
   `fleet-command` (a conductor over fleets, never a destination) and
   `issue-fleet` itself (the producer — routing an issue to the router is a
   cycle). That yields 12 destinations, a superset of the six in the vendored
   skill's comment and of the four #886 named as having no legal destination.

3. **`route:unroutable` is a label, not an absence.** Absence is ambiguous: it
   means either "nobody has triaged this" or "somebody triaged it and found no
   destination". Collapsing those two _is_ the silent drop.

4. **The denominator is read off the issues, never through the label filter.**
   `gh issue list --label` lags writes and under-reports — observed twice during
   the run that filed #1071. A report built on it under-counts silently and
   still looks green. `scripts/route-queue.mjs report` enumerates open issues
   with no `--label` flag, and `ts/test/route-labels.test.ts` asserts the flag's
   absence from the recorded `gh` argv rather than merely checking that the
   number came out right.

## Consequences

- A route recorded as a label is readable in any later session, by any tool,
  with no access to the session that wrote it. The acceptance bullet is met by a
  queryable fact rather than a transcript.
- `report` distinguishes four populations — routed, unroutable, untriaged,
  conflicted — whose sizes **sum to** the denominator. An issue cannot fall out
  of the report without breaking arithmetic, which is what makes the "never
  silently dropped" guarantee mechanical rather than aspirational.
- A zero denominator exits **3** (abstention), consistent with ADR 0009. "0
  routed" with a green exit is exactly the false green this repo keeps closing.
- An issue carrying two route labels is reported as `conflicted` and is never
  auto-resolved: two triage passes disagreed, and picking one silently corrupts
  the downstream queue with an answer nobody chose.
- The vocabulary is pinned by a test, so a roster change fails CI rather than
  drifting. When the upstream enum widens under #886, the two lists must be
  reconciled deliberately.
- `ensure-labels` only ever creates. Nothing in this tooling deletes, renames,
  or edits a label, so a mis-run cannot destroy triage state.
