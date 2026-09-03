---
number: 15
title: 'ADR 0015 — Skill capability is three axes, not a tier'
date: 2026-09-03
status: accepted
source: adr
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0015 — Skill capability is three axes, not a tier

**Status:** accepted **Date:** 2026-09-03 **Deciders:** Bri Stevenski
(maintainer) **Related:** #753 (this vocabulary is undefined and self-
contradictory); ADR 0007 (the guardian agent-capability boundary, which is where
the tier numbers came from); #754 (the same family of problem — shared
vocabulary with no authoritative source)

## Context

Skills across the repo describe their capability level as `Tier-0`, `Tier-1`, or
`Tier-2`. Nothing defined the scale, and two shipped skills used `Tier-1` to
mean opposite things:

| Where                                          | What `Tier-1` meant there                   |
| ---------------------------------------------- | ------------------------------------------- |
| `agents/skills/claude-code/canary-savant`      | the deterministic, no-network, no-LLM floor |
| `agents/skills/claude-code/canary-pr-guardian` | the first pass that requires an agent       |

Savant made the contradiction visible in a single file: it called its static
scan "Tier 1" and, four lines later, called that same scan "Tier-0 in the real
sense."

Skill descriptions are the primary discovery surface, so an ambiguous capability
claim misleads at exactly the moment someone is choosing a skill. Worse,
`Tier-0` _is_ load-bearing — the guardian has tests asserting its Tier-0 engine
imports no agent or LLM module — and ambiguity in 1 and 2 erodes confidence in 0
by association.

### Why one scale could not carry it

The properties being described are independent booleans, not ordered points:

- **deterministic** — same input, same output, or not.
- **network** — needs to reach outside the repo, or not.
- **agent** — invokes a model, or not.

A skill can hold any combination. A skill that is deterministic,
network-requiring, and agent-free sits at no single tier number, which is
exactly why `canary-manhunter`'s proposal declined to claim one. Collapsing
three independent booleans onto one integer loses information, and that loss is
what produced the contradiction.

## Decision

**1. Capability is described by three axes, never by a number.** A skill states
`deterministic`, `network`, and `agent` — each independently true or false, and
each independently checkable. Prose may say "deterministic, no network, no
agent" instead of listing them; the point is that the three are stated, not that
they take a particular syntax.

**2. `Tier-0` is defined once, as their conjunction:** deterministic, no
network, no agent or LLM. It survives as shorthand only because it is
load-bearing — `ts/test/guardian-agent-tier.test.ts` asserts the boundary — and
because four detectors (`canary-cassandra`, `canary-savant`, `canary-blackhawk`,
`canary-katana`) already agree on exactly that meaning. Nothing may call itself
Tier-0 without satisfying all three.

**3. `Tier-1` and `Tier-2` are retired as cross-skill vocabulary.** They remain
valid in exactly one place: `canary-pr-guardian`, where they are not a
capability scale at all but the values of a runtime flag,
`canary guardian pr-check --tier 0|1|2`, resolved by `ts/src/guardian/tier.ts`
and `agent-tier.ts`. Inside guardian, "Tier 1" means "the `--tier 1` pass" — a
CLI contract with an existing degradation notice, not a claim about capability.
Outside guardian, the numbers carry no meaning and must not be used.

**4. A skill with internal phases names them for what they do.** Savant now has
a **static pass** and a **confirming pass** (`--confirm`), which is what they
were, and which cannot be confused with guardian's flag values.

### Scales named "tier" that this ADR does not govern

Three unrelated uses of the word survive, deliberately, and none of them is a
capability claim:

- **`canary doctor` tiers** (`docs/guides/doctor.md`, `npm/src/doctor.ts`) —
  check _provenance_: tier 1 is built-in engine checks, tier 2 is data-driven
  overlay checks read from a clone's manifest. It is a data contract; renaming
  it is a product change, not a documentation one.
- **Vendored harness agent definitions** (`agents/agents/**/harness-*.md`) —
  violation _severity_: Tier 1 blocks commit, Tier 2 blocks merge. These files
  are vendored from upstream harness-engineering and are not canary's to
  redefine.
- **Coverage fidelity tiers** inside the guardian (graph / heuristic) — a
  confidence label on a coverage finding, already named in words.

## Consequences

- The four detectors keep their `Tier-0` claim and now have a definition to be
  measured against. Each already satisfies all three axes.
- `canary-savant`'s frontmatter and body no longer claim a tier. Its discovery
  description says what it does — a static scan, and an opt-in confirming pass —
  which is more informative than a number a reader had to look up.
- `agents/skills/README.md` matches the skills it summarises.
- New skills state the three axes and do not re-litigate the scale.
  `canary-manhunter` can now describe itself honestly: deterministic, network,
  no agent.
- `canary-pr-guardian` is unchanged in behaviour. Its numbers are now scoped in
  writing to the flag they name, so a reader who meets "Tier 1" there knows it
  is a flag value and not a capability class.

## Alternatives Considered

**Redefine `Tier-1` and `Tier-2` globally and reconcile every skill to the new
meanings.** Rejected. It keeps a one-dimensional scale for a three-dimensional
property, so the next skill that does not fit — one that is deterministic but
needs the network, say — reopens the same question. It also would have forced a
rename of guardian's `--tier` flag, a breaking CLI change, for a documentation
defect.

**Add `deterministic` / `network` / `agent` keys to every skill's frontmatter
and validate them in CI.** Attractive, and still open. Rejected _for now_ only
because the frontmatter schema is shared with the plugin loader and adding keys
to it is product work; this ADR is the vocabulary half. The axes are written so
that a later schema change encodes them without redefining them.

**Say nothing and let each skill define its own tiers locally.** Rejected. That
is the status quo, and the status quo produced two shipped skills that
contradict each other.
