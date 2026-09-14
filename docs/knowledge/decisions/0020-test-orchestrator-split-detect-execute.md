---
number: 0020
title: Canary detects, harness test-fleet executes
date: 2026-09-13
status: accepted
tier: medium
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0020 — Canary detects, harness test-fleet executes

**Status:** accepted **Date:** 2026-09-13 **Deciders:** Bri Stevenski
(maintainer) **Related:** #835 (source issue); ADR 0008 (guardian ownership, the
same canary-owned/harness-leveraged pattern)

## Context

Two orchestrators now claim the same job — turning a coverage gap into authored,
reviewable tests.

`canary-test-pipeline` chains `canary-critical-areas` →
`canary-edge-case-discovery` → `canary-failure-impact` → `canary-write-test` →
`canary-ci-ready` in a convergence loop with a health report.

`test-fleet` (harness, tier 2) enumerates under-covered areas and uncovered
critical paths, confirms a ranked batch with the human once, fans out
worktree-isolated subagents that author via `harness-tdd` then `test-craft`,
independently verifies each by added behaviour-asserting tests, and returns a
batch of PRs for one review.

The phases genuinely differ in strength, and the split is clean. Canary is
better at **detection** — risk ranking by churn and dependents, edge-case
categories, blast radius. Harness is better at **execution** — worktree
isolation, batch confirmation, independent verification, PR-per-target.

Left unresolved they diverge into two convergence loops, two health reports, and
two definitions of "covered".

There is a second, sharper reason not to leave both running. Absolute ratchets
do not compose across parallel PRs in this repository — it is recorded and it
bit us at merge time, where individually-green branches went red as a stack. A
fleet that fans out worktree-isolated test PRs hits exactly that. Whichever
orchestrator owns the fan-out needs the serial-merge and re-measure discipline
built in; two orchestrators each believing they own the batch guarantees it is
built into neither.

The wiring direction is already established in this direction: `harness-tdd`
calls `canary_probe` and then offers `/canary-write-test`. This decision is the
same relationship one level up.

## Decision

**1. Canary's pipeline is the detection and ranking phase. Harness `test-fleet`
is the execution phase.** Canary stops running its own authoring convergence
loop over targets a fleet is also authoring for.

| Phase                                      | Owner                        |
| ------------------------------------------ | ---------------------------- |
| Risk ranking of targets                    | `canary-critical-areas`      |
| Per-target authoring guidance              | `canary-edge-case-discovery` |
| Severity that orders the batch             | `canary-failure-impact`      |
| Authoring, worktree isolation, PR assembly | harness `test-fleet`         |
| Terminal check on the result               | `canary-ci-ready`            |

**2. This ADR commits canary's side only. The harness capability it depends on
is an explicit precondition, not work this decision schedules.** The split
requires `test-fleet` to accept an _externally supplied_ target batch rather
than insisting on enumerating its own. Whether it does is unverified as of this
record. Under the standing project rule, canary's upstream harness work ends at
a green PR on the harness repository — canary cannot land that change. So:

- If `test-fleet` already accepts an external batch, the split is implementable
  entirely within canary.
- If it does not, the required upstream change belongs with the pending
  canary-to-harness contribution batch (strix, shadow, instrument ingest), which
  is not yet filed. **That contribution is a precondition of this ADR taking
  effect, and this ADR does not claim to deliver it.**

Recording the dependency as a precondition rather than as a task is the point.
An ADR that scheduled upstream work would be committing to something the fleet
that wrote it structurally cannot do.

**3. Serial-merge and re-measure discipline is stated wherever the fan-out
lands.** Because the fan-out is harness's under this split, canary's
documentation must state the constraint at the handoff point rather than assume
the executing side knows it. Absolute ratchets in this repository are measured
against a baseline that parallel branches each pass independently and the stack
fails collectively.

**4. `canary-test-pipeline` keeps a standalone mode for repositories without
harness.** Canary is a separately pitchable asset and must remain useful where
harness is not installed. Standalone mode runs the full detect-and-author loop;
where harness is present, authoring defers to `test-fleet`. The mode is selected
by whether harness is available, not by a flag a user must remember.

## Consequences

- One documented owner per phase, with each skill pointing at the other for the
  phases it does not own. No repository runs two convergence loops over the same
  targets.
- Canary's detection surface becomes an interface, not just an internal step.
  Its ranked output has to be stable and consumable, which is a real design
  constraint that did not previously apply.
- The split is **blocked, not broken**, if `test-fleet` cannot take an external
  batch. In that state both orchestrators keep running as today and this ADR
  remains accurate about what has and has not happened. Verifying that
  capability is the immediate next action.
- Canary retains full standalone capability, so nothing about this split reduces
  what canary can do on its own or weakens it as a pitchable asset.
- The serial-merge constraint moves from tribal knowledge into a stated handoff
  requirement, which is the only form in which the executing side can honour it.
- Two health reports collapse to one. The definition of "covered" becomes
  whichever side owns the terminal check — `canary-ci-ready` — which is also the
  side that owns the risk model that produced the targets.
