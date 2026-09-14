---
number: 0021
title: Targeted pursuit is a canary-cry mode; canary-huntress stays reserved
date: 2026-09-13
status: accepted
tier: small
source: 'adr'
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0021 — Targeted pursuit is a mode of canary-cry

**Status:** accepted **Date:** 2026-09-13 **Deciders:** Bri Stevenski
(maintainer) **Related:** #617 (canary-huntress, second scope attempt); #608
(canary-cry); ADR 0015 (skill capability vocabulary)

## Context

`canary-huntress` (#617) and `canary-cry` (#608) are two backlog items whose
scopes overlap, and neither can be specced until the boundary between them is
drawn. They are a single coupled decision, not two independent ones.

`canary-cry` is a timeboxed adversarial exploration ahead of a launch, so a
sales demo never has to explain away a bug. It targets real-world abuse of
ordinary user flows — impatient double-submit on a degraded network, a
back-button midway through a multi-form flow that already wrote partial rows,
token expiry mid-flow — with state corruption as the success criterion rather
than a rendering defect. It has an `--amplitude` dial (`whisper` / `shout` /
`scream`) where amplitude is how hard each flow is pushed and radius is how many
flows are hit, and it composes the existing canary skills rather than forking
them. Its scope is concrete and its accepted risks are enumerated.

`canary-huntress` is the reverse. `canary-huntress` is a **name** from the Birds
of Prey pool that was reserved before it had a job, and #617 is the _second_
attempt to find it one — hunting one specific defect class across the entire
suite and its history. The issue is candid about why that attempt did not clear
the bar: `git bisect` already finds _when_ a regression entered, and
`canary-cry` already explores broadly, so the remaining slice — find every other
place this same bug shape exists — may be too narrow to justify a skill rather
than a flag on an existing one.

Its own wording names the problem exactly: _"this is a reserved name looking for
a job, which is the wrong direction of fit."_ A name in search of scope is
evidence about the name, not about the capability.

## Decision

**1. Targeted defect-class pursuit becomes a mode of `canary-cry`, not a
separate skill.** The residual capability #617 describes is real and worth
having: given one defect shape, sweep the suite and its history for every other
place that shape occurs. It is simply not a separate orchestrator. It is a
narrowing of the same adversarial sweep `canary-cry` already performs —
`canary-cry` at minimum radius and maximum specificity, pointed at a known shape
instead of at a flow catalogue. Expressing it as a flag or mode reuses the
amplitude/radius dial, the composition with `canary-edge-case-discovery` and
`canary-failure-impact`, and the deterministic-repro requirement, none of which
a second skill should reimplement.

**2. `canary-huntress` returns to the reserved pool. It is not retired.** The
name stays available for a future capability that genuinely needs it. What is
abandoned is this scope attempt, not the name. This distinction is recorded
explicitly because the two are easy to conflate and the consequence of
conflating them is permanent: a retired name is gone from the Birds of Prey
roster, and there is no reason to spend one on a failed fit.

**3. The direction-of-fit rule is the generalisable part.** A capability earns a
name. A name does not earn a capability. Two attempts have now started from the
name and searched for work to justify it; both produced a scope that overlapped
something existing. Future reserved names wait for a capability that arrives on
its own and needs naming — the reservation is a claim on a label, never a
commitment to ship something under it.

## Consequences

- `#617` closes as decided rather than lingering as a third scoping attempt. The
  roadmap row it mirrors should reflect the same outcome, since the row is the
  planning record and closed issues sitting as `backlog` make priority reads
  wrong.
- `canary-cry`'s spec grows one mode and its acceptance criteria grow with it.
  Its three accepted risks are unchanged by this decision and still need
  handling in the spec — the non-prod target allowlist with prod refused by
  default, the convergence criteria that stop an unbounded `scream` being a
  token and wall-clock bomb, and the requirement that every finding carry a
  replayable repro with seed and state.
- The targeted mode inherits the deterministic-repro requirement, which it needs
  more than broad exploration does: a defect-class sweep that reports
  occurrences without repros produces a triage queue nobody can action.
- `canary-huntress` stays in the reserved list in the Birds of Prey roster,
  neither used nor retired, with this ADR as the record of why it is still
  waiting.
- One fewer orchestrator to keep aligned. The overlap that blocked both specs is
  removed, and `canary-cry` can be specced immediately.
