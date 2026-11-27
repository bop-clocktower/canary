---
type: business_rule
domain: gates
source: authored
related:
  - docs/changes/616-canary-harley/proposal.md
  - docs/knowledge/gates/evidence-brief.md
---

# Proposed invariant: confirmed by a human before it becomes a test

A **proposed invariant** is a ranked, heuristic candidate that `canary-harley`
reads from a function signature: a round trip, idempotence, commutativity and
four other kinds. Two rules govern it.

## Rule 1: a proposed invariant becomes a test only after a human confirms it

`propose` generates nothing. `emit` requires `--confirm` with explicit candidate
ids, exits 2 without it, and has no "confirm all". The skill tells an agent to
present the list and stop, and never to supply `--confirm` itself.

**Why.** A signature suggests an invariant; it does not establish one. A lossy
encoder has the shape of a round trip and fails it by design. A test written
around an unconfirmed invariant either fails for a reason nobody chose, or
passes and asserts something nobody checked. The score is a fixed prior per kind
plus a name cue, so it is labelled `heuristic` and never read as a measurement.

The confirmation is bound to the code that was read. A candidate id hashes the
kind and the parameter and return types, and `emit` derives the candidates again
from the file. When a type changes, the old id matches nothing and `emit`
abstains with exit 3.

## Rule 2: generated property tests carry a fixed, recorded seed

Every generated file names its seed and run count as constants, records both in
its header and passes the seed to the framework. The default seed is derived
from the candidate id. Hypothesis output also sets `database=None` and
`deadline=None`.

**Why.** An unseeded generator is a flake source: the same test passes on one
run and fails on the next, and the failing input is gone. A recorded seed makes
a failure replayable, and a seed derived from the id is stable across runs while
still differing between tests.
