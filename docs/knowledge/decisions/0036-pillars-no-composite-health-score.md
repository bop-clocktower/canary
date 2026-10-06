---
number: 0036
title: QA health is shown as pillars, never one composite score
date: 2026-10-06
status: accepted
tier: medium
source: docs/changes/canary-qa-site/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0036 — QA health is shown as pillars, never one composite score

**Status:** accepted **Date:** 2026-10-06 **Deciders:** Bri Stevenski
**Related:** [#1151](https://github.com/bop-clocktower/canary/issues/1151);
`docs/changes/canary-qa-site/proposal.md` (D6); ADR 0035 (the two-layer QA data
contract); ADR 0009 (exit 3 reserved for "abstained")

## Context

An audited QA dashboard's best-explained output was a weighted 0–10 health
score: each factor had a weight and a reason, and a factor with no data was
excluded and named rather than counted as zero. The audit's verdict on it was
"keep". A consumer's health-signal work reached the opposite rule, "pillars,
never a composite", and canary's strategy is fidelity-labeled evidence over
verdicts.

A composite has three problems the factor list does not. Its weights are a
policy that nobody reviews once they are buried in a number. A drop in one
factor is masked by a rise in another. And when a factor abstains, the composite
is either renormalised over fewer factors (a different number with the same
label) or treated as zero (a false red), and neither is visible in the number.

## Decision

The QA site shows every assessment side by side in `<canary-pillars>`: status,
value with its unit, evidence tier and denominator. A `not-assessed` pillar
shows its reason as text and announces it in a live region. No panel computes or
renders a composite, weighted, averaged or "overall" health number, and
`canary.assessment/1` has no field for one.

The abstaining-factor behavior from the audited dashboard is kept; the weighted
sum is not.

## Consequences

- A reader sees which factor is weak, with its evidence tier, instead of one
  number they have to take on trust.
- A panel test asserts that no composite appears (`site-kit-pillars.test.ts`).
- A team that needs a single traffic light has to derive it outside the kit,
  with its own reviewed weights. Canary will not ship one.

## Alternatives Considered

- **Weighted composite with abstaining factors excluded.** Keeps the audited
  dashboard's best output, but renormalising hides that the number now means
  something different. Rejected.
- **Worst-of status** (the site is "critical" if any pillar is). Honest about
  direction but still a verdict over evidence, and it hides which pillar.
  Rejected; a reader sees the worst pillar directly.
- **Composite shown next to the pillars.** The number becomes what people quote,
  which is the masking problem again. Rejected.
