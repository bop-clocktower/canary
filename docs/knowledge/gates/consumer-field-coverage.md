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

The store can be full of runs and a consumer still dark: `analyze area-health`
over runs that carry no `area` renders an empty table, and a failure-category
report over tests with no `failure_category` renders one `other` bucket. Both
look like a quiet week. Neither is a measurement. Found by #610, which showed
that three declared, read fields (`area`, `failure_category`, `tags`) were
written by no writer.

The rules `canary history gaps` applies:

- **Coverage is per field, over the rows the field applies to.** A
  `failure_category` is only meaningful on a failed or flaky test, so passing
  tests are not in its denominator.
- **No applicable rows is unmeasured, never fed.** The #508 denominator doctrine
  applied per field: "0 of 0 failed tests carry a category" says nothing about
  the writer.
- **A missing store and an empty store abstain with different reasons.** The
  reader returns nothing for both, so the command checks existence itself.

Implementation: [gaps.ts](../../../ts/src/analysis/clocktower/gaps.ts), with the
consumer table in
[consumers.ts](../../../ts/src/analysis/clocktower/consumers.ts).
