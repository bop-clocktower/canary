---
type: business_rule
domain: strategy
source: STRATEGY.md
---

# Our approach

Bet on fidelity-labeled evidence over verdicts. Canary never asserts "this is
tested" — it states how it knows, ranked coverage-verified › graph-verified ›
heuristic, and degrades loudly when the evidence tier drops rather than silently
guessing. Auditable provenance is the precondition for letting an agent near a
merge gate.

Second bet: a deterministic Tier-0 engine that imports no LLM, with the agent
tier strictly optional on top — so the gate stays reproducible, cheap, and
secret-free while intelligence layers above it.

Third bet: meet the engineer during development rather than at a release gate,
picking up immediately downstream of harness-engineering's architectural and
spec governance.
