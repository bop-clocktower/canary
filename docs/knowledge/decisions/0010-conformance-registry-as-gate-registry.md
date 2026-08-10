---
number: 10
title: 'ADR 0010 — The conformance registry is the canonical gate list'
date: 2026-08-03
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0010 — The conformance registry is the canonical gate list

**Status:** accepted **Date:** 2026-08-03 **Deciders:** Bri Stevenski
(maintainer) **Related:** #508; `docs/changes/no-silent-abstention/proposal.md`
(Decision D5); ADR 0009 (exit 3 reserved)

## Context

ADR 0009 establishes what a gate must do on a collapsed denominator. That leaves
a harder question: **how do we know a surface is a gate at all, and how does a
gate added next year inherit the rule?**

Three mechanisms were available:

1. **Documentation.** A doctrine section in `AGENTS.md` saying "every gate must
   abstain". Cheap, and worth exactly nothing the first time someone ships a
   command without reading it.
2. **Detection.** A heuristic sweep that finds commands printing a success line
   without consulting a denominator. Tempting, but it needs to understand intent
   — advisory commands legitimately print all-clears — so it would be noisy in
   both directions, and a noisy detector is one that gets suppressed.
3. **Registration.** A table where every gate has a row, and the row's fixture
   proves the loud outcome by running the real command.

The audit that produced #508 also showed why documentation alone fails here: the
bug had _tests ratifying it_. `history flaky` had a passing test asserting
`No tests above 10%` over an empty store; blackhawk and savant had tests
asserting a clean bill of health while pointing at an empty directory. The suite
was not silent about the defect — it was confirming it, every run.

## Decision

**The conformance registry table IS the canonical list of gates.** A new gate is
not done until it has a row, and each row carries: the command, its layer, its
gate-or-advisory classification, a fixture that collapses its denominator, and
the success copy that must never appear.

The registry is **partitioned by runtime, not by taste** — three files, because
the three layers cannot execute each other:

| Layer  | File                                             | Why it is separate                                          |
| ------ | ------------------------------------------------ | ----------------------------------------------------------- |
| engine | `ts/test/gate-conformance.test.ts`               | vitest over ESM engine sources                              |
| npm    | `npm/scripts/__tests__/gate-conformance.test.js` | CommonJS package; `node:test`; cannot be imported by vitest |
| skill  | `agents/skills/test/gate-conformance.test.ts`    | self-contained `.mjs` CLIs that import no engine code       |

Every row runs the **real command**, not a unit under test. A row that called an
internal function would prove the function abstains while the CLI still printed
a green line above it — which is the bug, one layer down.

## Consequences

**Classification becomes a reviewed one-line diff.** "Is this a gate or
advisory?" stops being a judgment made silently inside an implementation and
becomes a visible row in a table, argued in review. Surfaces that need _no_
change still get rows — `heal-test` (denominator is always exactly 1) and
`skills run` (its exit ladder was already conformant) are recorded as audited so
a future reader does not re-litigate them.

**"By convention" gets teeth.** Skill CLIs cannot import `gateOutcome`; they
hand-write a matching `ABSTAINED_LINE`. Without the skill-layer registry that
convention would mean "by nobody" — the registry is the only thing that makes
the convention load-bearing.

**Coverage is bounded by honesty, not by the tool.** The registry can only
contain gates someone registered. We accepted that over a detection sweep
(YAGNI, revisit if a gate ships unregistered) because a heuristic that must
infer intent will either miss real gates or cry wolf on advisory ones, and both
failure modes end with the check being ignored.

**The pattern generalizes.** This is a table-driven registry enforcing a
cross-cutting contract by running real entry points — the same architecture #479
wants for argument-parser conformance. The two can share the harness.

## Enforcement of the enforcement

A registry that never runs enforces nothing. The npm package's suite ran in
**zero** CI jobs until Wave 3 added the `npm package` job — `release.yml` built
the package at tag time but never tested it. That gap made the npm registry
inert on arrival, which is the doctrine's own failure mode applied to its
enforcement mechanism. All three registries now run on every PR.
