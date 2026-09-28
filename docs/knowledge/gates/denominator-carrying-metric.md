---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
  - docs/changes/609-canary-signal/proposal.md
---

# Denominator-carrying metrics

A reported number travels with the count it was measured over. When that count
is zero, the metric **abstains** — it prints `ABSTAINED` and why, never `0`.

## Why

"0 failures caught" over zero pre-merge runs reads as a quiet week. It is
actually an instrument that saw nothing. Printed in a digest meant to make QA
visible, that zero undersells the work and inverts the goal (#609). It is the
same false-green shape as "0 tests failed" out of zero tests (#508).

## The rule

- A metric has exactly two shapes: `{value, denominator}` or
  `{abstained, reason}`. There is no bare number.
- A structural zero is not a measured zero. A reporter that cannot emit `flaky`
  does not contribute to the flaky denominator (#604).
- A record that cannot answer the question stays out of the denominator. A
  count-only run (no per-test rows) cannot say which test failed, so it is not
  in the failure denominator; it is named as a sample note instead.
- A source that could not be read is named as dark, with the reason, rather than
  contributing nothing silently. A source that does not exist at all (production
  escapes) is named too.
- A thin sample is stated before any number is (`THIN SAMPLE`, below 3 runs).

## Where it is implemented

- [`tally.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/tally.mjs)
  — `measured()` and every metric.
- [`digest.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/digest.mjs)
  — renders abstentions and the dark-sources section.
- [`window.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/window.mjs)
  — counts undated records instead of dropping them.
- [`sources.mjs`](../../../agents/skills/claude-code/canary-signal/scripts/sources.mjs)
  — separates a dark optional source from a mistyped path.
