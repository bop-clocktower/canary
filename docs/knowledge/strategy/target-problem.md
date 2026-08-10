---
type: business_rule
domain: strategy
source: STRATEGY.md
---

# Target problem

Teams ship test suites that pass without proving anything. Line-coverage
percentages — the number that typically gates a merge — can be maxed out by
assertion-free tests, so the gate is uncorrelated with whether a regression
would actually be caught. The cost of authoring genuinely good tests (knowing
the framework, the edge cases, the real risk surface) lands on whoever has the
least time to pay it. Suites then decay silently until a launch or a demo
exposes them.
