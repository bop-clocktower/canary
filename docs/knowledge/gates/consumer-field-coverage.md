---
type: business_rule
domain: gates
source: authored
related:
  - docs/knowledge/gates/false-green-detection.md
  - docs/guides/history-gaps.md
---

# Consumer field coverage

A run-history consumer is only as live as the least-populated field it reads.

The store can be full of runs and a consumer still dark: canary-screech over
failures that carry no `area` recommends `investigate` for every break, and a
failure-category report over tests with no `failure_category` renders one
`other` bucket. Both look like a quiet week. Neither is a measurement. The issue
that found this showed three declared, read fields (`area`, `failure_category`,
`tags`) written by no writer (#610).

The rules `canary history gaps` applies:

- **Coverage is per field, over the rows the field applies to.** A
  `failure_category` is only meaningful on a failed or flaky test, so passing
  tests are not in its denominator.
- **The denominator is what the consumer reads.** canary-screech does not count
  a flake as a failure, so its denominators leave flakes out; where a consumer
  exports its own predicate (rewind's refusals, flake-window's capable readers),
  the table calls it rather than copying it.
- **No applicable rows is unmeasured, never fed.** The #508 denominator doctrine
  applied per field: "0 of 0 failed tests carry a category" says nothing about
  the writer.
- **A missing store and an empty store abstain with different reasons.** The
  reader returns nothing for both, so the command checks existence itself.

Implementation: [gaps.ts](../../../ts/src/analysis/clocktower/gaps.ts), with the
consumer table in
[consumers.ts](../../../ts/src/analysis/clocktower/consumers.ts).
