---
number: 0028
title: Six-scope flair cascade with per-value provenance
date: 2026-09-15
status: accepted
tier: medium
source: docs/changes/bop-subbranding/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0028 — Six-scope flair cascade with per-value provenance

**Status:** accepted **Date:** 2026-09-15 **Deciders:** Bri Stevenski
**Related:** docs/changes/bop-subbranding/proposal.md (D7, D9, success criterion
5); ADR 0027 (registry + codegen); `ts/src/core/company-knowledge.ts` (merge
cascade)

## Context

The BoP sub-branding proposal adds a 0–3 flair dial with per-surface trim knobs
(D7). Users need to set flair per company, client, codebase, environment, test
set and single run, so it can be turned off for client deliverables (Goal 6) and
turned up for internal use. The proposal flags D9 for an ADR because "the
precedence order will be re-litigated without a written record".

It depends on ADR 0027: the codegen stamps a copy of the resolver into each
skill's `brand.mjs`, so the rung set is also a contract the generator has to be
able to embed.

The existing CompanyKnowledge merge cascade in
`ts/src/core/company-knowledge.ts` already orders `~/.canary/company.json` <
`.canary/company.json` < `.canary/company.<env>.json`, with scalar fields
replaced by the highest-priority source.

Options considered:

- A) Six scopes above the default, most specific wins, provenance on every
  resolved value.
- B) Collapse to four rungs (default < project < env var < flag).
- C) Drop the test-set/reporter rung and keep the rest.

## Decision

Adopt option A. Flair resolves lowest to highest priority, and the most specific
scope wins:

default < org (`~/.canary/company.json`) < project (`.canary/company.json`) <
env (`.canary/company.<env>.json`) < `CANARY_FLAIR` < test-set/reporter config <
`--flair` flag.

The three file rungs reuse the existing CompanyKnowledge merge order and its
scalar-replacement rule rather than a second precedence implementation.
`resolveFlair(sources)` in `ts/src/core/flair.ts` is a pure function returning
`{ level, surfaces, provenance }`. Every resolved value, the level and each
surface knob, records the scope that set it by name, and `canary flair` reports
it.

Per ADR 0027, the resolver stamped into skills must implement the same order. A
skill that cannot see a rung (for example no test-set/reporter config in its
context) treats that rung as unset and says so in provenance. It never silently
reorders the chain.

## Consequences

- Every scope a user needs has a rung, so a client engagement can pin level 0 in
  `company.<env>.json`, and only an explicit env var, test-set config or flag
  can override it. Those overrides are visible in provenance.
- One order across core CLI and skills. The cascade test is per adjacent rung
  pair: the more specific scope wins, and `canary flair` names the winner
  (proposal success criterion 5).
- Six rungs is more surface to test and explain than four. Provenance is the
  mitigation: "why is flair 3 here?" is answered by the tool, not by reading
  this ADR.
- Coupled to ADR 0027. Changing the rung set means changing the generator
  template and regenerating every skill, and the drift gate enforces that.
- Risk: a per-surface knob and the level can come from different scopes, which
  may surprise users. Provenance is reported per value, not once per resolution,
  for that reason.
- Nothing is built by this ADR. `flair.ts` does not exist on main as of
  6aa3158d.
