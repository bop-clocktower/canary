---
number: 0033
title: The waypoint sink stays unconfigured, and the abstention is recorded
date: 2026-09-22
status: accepted
tier: small
source: docs/changes/967-waypoint-sink-decision/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0033 — The waypoint sink stays unconfigured, and the abstention is recorded

**Status:** accepted **Date:** 2026-09-22 **Deciders:** Bri Stevenski
**Related:** [#967](https://github.com/bop-clocktower/canary/issues/967);
`docs/changes/967-waypoint-sink-decision/proposal.md` (D1–D4); ADR 0009 (exit 3
reserved for "abstained"); ADR 0026 (a partial metric kept and disclosed)

## Context

Every roadmap-fleet lane ends by running:

```bash
harness waypoint record-provenance docs/changes/<slug>/provenance.json
```

and every run to date has returned, verbatim:

```text
Waypoint sink not configured (harness.config.json `waypoint.sink`); nothing recorded.
```

exiting 0. Issue #967 was filed after the 2026-09-15 fleet run (PRs #958–#962)
observed it on every lane, and asks the repo to decide: configure the sink, or
record why not — "so the no-op is not mistaken for a working seam".

**The key is absent, not broken.** This is worth stating because canary has a
known class of harness config keys that sit at paths the schema never reads and
get silently stripped, and an abstention caused by one of those would be a bug
wearing a decision's clothes. `waypoint` is not one of them: the shared config
loader declares it as a tolerant passthrough specifically so it does not trip
the stripped-key warning, and `loadWaypointConfig` reads `parsed.waypoint`
straight off the parsed file. If the key were set, it would take effect.

**What setting it would actually buy.** `waypoint.sink.transport` accepts
exactly one value, `"spool"`, which appends JSONL segments to a repo-local
`.harness/spool/`. Getting those events anywhere else is a separate, optional
`ship` block that requires four things canary does not have: a service `url`, an
`outpost` identifier, a `project` identifier, and a
`PNYON_WAYPOINT_INGEST_TOKEN` bearer credential supplied from the environment.
There is no Waypoint service for this repository to point at.

## Decision

**Canary deliberately does not configure `waypoint.sink`, and this record is the
disclosure of that abstention.**

1. `harness waypoint record-provenance` continues to print "Waypoint sink not
   configured (harness.config.json `waypoint.sink`); nothing recorded." and
   exit 0. That behaviour is expected and is not a defect to fix.

2. The silence is a **deliberate abstention, not a failure**. Nothing is
   half-wired and no one forgot a step. `harness.config.json` carries no
   `waypoint` key on purpose, and a PR that adds one is a change to this ADR,
   not a bug fix.

3. Configuring `"spool"` today would be speculative. It would produce a local
   spool that grows on every fleet lane, ships nowhere, and is read by nothing
   but `harness waypoint status`, which reports the spool's own health — segment
   count, event count, drops, oldest-event age — rather than anything about the
   work. That is strictly more moving parts than the abstention it replaced,
   delivering the same amount of information to the same zero consumers of the
   events themselves. The alternative is not "provenance recorded" versus
   "provenance lost"; it is "nothing recorded and said so" versus "nothing
   recorded and a directory to prune".

4. This ADR is the only place the decision is written. No parallel note in
   AGENTS.md: the abstention is met in fleet lane output rather than while
   reading AGENTS.md, the message text greps straight to this file, and a second
   copy of the reasoning is one more thing to drift.

## Consequences

**Fleet provenance lives only as the committed
`docs/changes/<slug>/provenance.json` artifacts.** Because nothing is emitted,
those files are not a convenience duplicate of a ledger held elsewhere — they
are the ledger. A future reader reconstructing what the fleets did, when, and
under which assumptions reads those files and the PRs that carry them. There is
no telemetry backend holding a fuller copy, and looking for one is a dead end.

**The cost #967 names is accepted knowingly.** As the issue frames it, lanes
never advance from fleet activity and wave forecasts stay cold-start. Recording
that here without independently confirming it: no consumer of these events
exists in the CLI at 12.10.0 — `sdlc.wave.*` appears there only as event-type
names in the contract list, and `harness predict` forecasts from timeline
snapshots, not from waypoint — so any such capability would be server-side, on
the Waypoint side of a sink canary does not have. Named anyway so that a later
"why is this always cold-start?" resolves to this decision rather than to a hunt
for a broken emitter.

**A grep lands here in one hop.** Anyone who meets the message and searches the
repository for "Waypoint sink not configured" reaches a record that says the
no-op is chosen, what the alternative would have cost, and what would change the
answer. That disclosure is what makes this a resolved decision rather than an
open defect — the same shape as ADR 0009 (an abstention gets its own reserved
exit code rather than masquerading as a pass) and ADR 0026 (a partial metric is
trustworthy only while it discloses that it is partial).

## Revisit test

Reopen this when **all four** of the following hold — they are what the `ship`
block requires, so short of all four there is still nothing to point at:

1. A reachable Waypoint service exists and canary has its origin `url`.
2. An `outpost` identifier is allocated for canary.
3. A `project` identifier is allocated for this repository. Neither it nor the
   outpost is derived: every route is `/outpost/<outpost>/project/<project>/…`,
   and a wrong value appends to a hash-chained log that cannot be taken back.
4. A `PNYON_WAYPOINT_INGEST_TOKEN` can be delivered from a secret store —
   Actions and Dependabot secrets, or a password manager for local runs. A token
   committed to `harness.config.json` or anywhere else in the tree is
   disqualifying on its own; the schema deliberately takes the credential from
   the environment for that reason.

Absent all four, reopening this is re-litigating the decision with no new
evidence.

## Alternatives considered

**Configure `waypoint.sink.transport: "spool"` now and leave shipping for
later.** Rejected. It is the option that most looks like progress and delivers
least: an unshipped, ever-growing `.harness/spool/` whose only effect is that
the honest "nothing recorded" message stops being printed. Removing the
disclosure while adding no reader is a net loss.

**Configure the sink together with a `ship` block.** Rejected as impossible
today rather than unwise. There is no service url, no outpost, no project id and
no token, and inventing values to satisfy a schema would produce a config that
fails at runtime while reading as configured.

**Record the decision in AGENTS.md instead of an ADR.** Rejected (D2). ADRs are
the repo's durable home for "why is it like this", and they are indexed,
status-tracked, and drift-gated by `ts/test/adr-index.test.ts`. AGENTS.md is
read at onboarding; this message is met mid-fleet-run.

**Leave it undocumented and let each reader rediscover it.** Rejected — that is
precisely the defect #967 reports. An undisclosed no-op is indistinguishable
from a broken seam, and the cost is paid again by every reader who investigates
it from scratch.
