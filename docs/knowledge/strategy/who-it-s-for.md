---
type: business_rule
domain: strategy
source: STRATEGY.md
---

# Who it's for

Primary: the engineer mid-development who has just had harness-engineering
govern their architecture, spec, and review, and now needs to know whether their
tests prove the thing works. They reach for canary while writing code —
unit-test generation, edge-case discovery, bug hunting — not at a release gate.
Today they rely on a coverage percentage and their own judgment about what is
worth testing.

Secondary: client-success and delivery staff who need to answer "is this
client's platform healthy and well-covered?" without reading code, and who query
canary for coverage, health, and fleet status.
