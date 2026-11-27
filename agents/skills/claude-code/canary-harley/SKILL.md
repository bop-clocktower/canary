---
name: canary-harley
description: >
  Proposes ranked, heuristic candidate invariants from the function signatures
  in one source file, and writes a seeded property test only for a candidate a
  human has confirmed.
requires: [node>=20]
---

# Canary Harley

Canary Harley reads the function signatures in one source file and proposes
candidate invariants for a human to confirm. A seeded fast-check or Hypothesis
test is written only for a confirmed candidate.
