---
number: 0018
title: Every detector is rehearsed against a planted defect
date: 2026-09-13
status: accepted
tier: medium
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0018 — Every detector is rehearsed against a planted defect

**Status:** accepted **Date:** 2026-09-13 **Deciders:** Bri Stevenski
(maintainer) **Related:** #834 (source issue); #884, #887 (false-green defects
found this run); ADR 0012 (entropy ratchet); ADR 0014 (gate wiring); ADR 0017
(named gaps)

## Context

Canary ships four deterministic detectors — `canary-savant` (order dependence),
`canary-blackhawk` (temporal dependence), `canary-katana` (deleted/skipped
tests), `canary-cassandra` (vacuous tests) — plus the entropy, perf, and
duration ratchets. Nothing proves any of them still fires.

A detector that stops firing does not fail. It goes quiet, and the quiet is
reported as a pass. That is the same false-green shape ADR 0014 addresses for
unwired checks and ADR 0017 addresses for unclassified files, one level further
in: here the check is wired, runs, and reports zero — and zero findings is
indistinguishable from zero defects.

This is not hypothetical. It has receipts in this repository:

- A CLI bump moved entropy 281 → 257 and perf 246 → 225 in one step. One was an
  upstream false-positive fix; the other was never examined. The rule that came
  out of it — "probe with a planted positive before trusting a fallen count" —
  is currently a habit enforced by nothing.
- Entropy reads 64 findings high in the main working directory versus a fresh
  worktree, so the same scan run in the wrong place returns confident garbage.
- A single fleet run surfaced four separate false-green defects in instruments
  that reported green without having looked: a flake scan blind to rerun-erased
  failures (#884), a doc gate that shrinks its own denominator (#887), guardian
  blind to non-ASCII filenames, and Cobertura hit-counts rebound to the wrong
  file.

Every one of those was found by a human noticing. None was found by a gate.

Upstream, `harness-rehearse` already solves this shape: fixtures under
`templates/rehearsal-fixtures/<id>/`, each planting exactly one failure mode,
each carrying a `rehearsal.json` manifest holding the ground truth of what was
planted and what should catch it. Its stated second purpose is precisely this
need — regression-test the gates themselves, because a fixture whose score
silently drops means a check that used to fire no longer does.

## Decision

**1. Every detector has a fixture that plants exactly one defect it must
catch.** One planted defect per fixture, with a ground-truth manifest naming the
detector that must fire. One defect per fixture, not several, so a fixture that
fails names a single detector rather than a set.

| Fixture                 | Planted defect                                               | Detector that must fire  |
| ----------------------- | ------------------------------------------------------------ | ------------------------ |
| order-dependent pair    | test B passes only after test A                              | `canary-savant`          |
| wall-clock dependency   | a real delay / local-timezone assertion                      | `canary-blackhawk`       |
| vacuous assertion       | a self-comparison and a bystander-absence assertion          | `canary-cassandra`       |
| last-coverage deletion  | a removed test that was the only cover of a high-risk symbol | `canary-katana`          |
| planted entropy finding | a dead export the scan must count                            | entropy ratchet          |
| planted slow test       | a test over the duration budget                              | perf / duration ratchets |

**2. The ratchets are in scope, not just the four detectors.** The receipted
failure mode in this repository is a _count_ that fell for an unexamined reason.
A ratchet is exactly an instrument that reports green by reporting a number, so
it is the one most able to go quiet without anyone noticing. Scoping this to the
deterministic detectors alone would exclude the case that actually happened.

**3. CI reports the denominator: `n fired of n expected`, never a bare pass.** A
run that asserts nothing and prints "ok" reproduces the defect being guarded
against. The job prints how many detectors were expected to fire and how many
did, and those figures must be equal.

**4. A skipped or unrunnable fixture is a failure, not a silent omission.** A
fixture that cannot be built, cannot be run, or is marked skip counts against
the denominator and fails the build. This is the clause that stops the suite
degrading into an empty watchlist that reports itself clean — the same shape as
a zero-item gate passing.

**5. A detector that does not fire on its own planted defect fails the build.**
That is the whole point: it converts "probe with a planted positive" from a
habit a careful human remembers into a gate that runs every time.

## Consequences

- Adding a detector now carries a second obligation: a fixture and a manifest
  entry. That is deliberate friction — a detector with no rehearsal fixture is a
  detector nobody can prove works.
- A CLI or dependency bump that silently disables a detector fails CI at the
  bump rather than months later. The entropy 281 → 257 / perf 246 → 225 episode
  would have produced a red fixture instead of an unexamined number.
- Fixtures are maintenance surface. A detector whose true-positive shape changes
  legitimately will need its fixture updated, and that edit is the moment to
  confirm the change was intended.
- The denominator clause means the job's output is auditable at a glance.
  `6 fired of 6 expected` is a claim that can be checked; "all detectors passed"
  is not.
- Scoring real changes is explicitly **not** in scope. Rehearsal scores recovery
  against a planted defect with a known-good fix; it is not a substitute for
  reviewing real work, and must never be reported as if it were coverage.
- The fixtures live in canary rather than upstream, so this gate is landable
  here. Reusing `harness-rehearse`'s own runner was considered and rejected: it
  would put the gate in a repository where the standing rule is that canary work
  ends at a green upstream PR, leaving canary unable to fix its own gate.
