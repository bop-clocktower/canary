# ADR 0008 — Guardian ownership: a canary skill that harness leverages

**Status:** accepted
**Date:** 2026-07-19
**Deciders:** Bri Stevenski (upstream maintainer)
**Related:** #312; `docs/changes/canary-pr-guardian/proposal.md` (Decision D2)

## Context

`canary-pr-guardian` sits at a project seam. It is a PR-scoped test-quality gate
— and "gates" are the kind of generic CI machinery that could plausibly live in
**harness** (the upstream orchestration layer, `Intense-Visions`). But its
substance is *test intelligence*: is this changed code tested, how good are the
affected tests, and can the missing ones be authored. That is squarely canary's
domain — the guardian is the PR-scoped, write-capable sibling of the existing
on-demand `canary-test-pipeline`, and it composes canary skills
(`canary-review-test`, `canary-write-test`, `canary-ci-ready`).

So the question is ownership: does the guardian ship as a **canary** skill, or
as a **harness** gate skill that leverages canary? The answer determines which
repo iterates on it, whether v1 is blocked on upstream timing, and where a
future generic gate host fits.

## Decision

The guardian ships as a **canary skill (`canary-pr-guardian`), owned in this
repo**, composing the canary test-intelligence skills (D2). Harness does not own
it; a future harness gate host *leverages* it as the CI surface, attaching
through the D1 capability boundary (ADR 0007) and the `.harness/analyses/`
producer contract (the reverse-handoff scoped in #899).

Concretely:

- **Test intelligence is canary's domain.** The guardian's value is coverage
  fidelity, test-quality audit, and test authoring — all canary capabilities.
  Homing it in canary keeps it next to the skills it composes.
- **v1 ships in-repo, in our control.** Canary is downstream/in-our-hands; a
  harness-owned skill would live upstream and block v1 on external release
  timing and review. Owning it here lets the baseline ship and earn trust now.
- **The future harness CI-agent tier attaches, it does not absorb.** When a
  harness gate host or CI-agent runner lands, it plugs into the *same*
  `AgentTier` boundary (ADR 0007) and consumes the guardian's structured results
  via the `.harness/analyses/` channel (#899) — so harness *leverages* the
  guardian without owning or forking it. This extends the established
  "harness surfaces/leverages canary" direction rather than fighting it.

## Consequences

### Immediate

- The guardian iterates at canary's pace — no upstream dependency gates v1.
- It lives beside `canary-test-pipeline`, `canary-review-test`, and
  `canary-write-test`, making the "PR-scoped sibling" relationship legible in
  one repo.
- `--emit-analysis` makes the guardian the **first real producer** of canary's
  structured analyses for harness to consume (#899), proving the reverse-handoff
  contract without harness owning the producer.

### Follow-on

- A harness gate host / CI-agent tier becomes a *consumer + host*, not an owner:
  it implements `CiAgentTier` against the ADR 0007 boundary and reads
  `.harness/analyses/`. No migration of the guardian into harness is required.
- If a genuinely multi-domain gate emerges later (docs-/security-guardian), that
  generic host belongs in harness — but the *test* guardian stays canary-owned;
  the two compose via the same producer contract.

### Risks

- **Perceived duplication with harness `review-ci`/`pre-merge-brief`.**
  Mitigation: the disambiguation matrix in
  `docs/guides/harness-canary-integration.md` states the split — those are
  generic PR gates; `canary-pr-guardian` is the test-quality specialist that
  feeds them via `--emit-analysis`.
- **Two homes for "gates" long-term.** Mitigation: ADR 0007's boundary means the
  guardian can be *hosted* by a future harness gate without being *owned* by it,
  so there is one gate surface even with canary-owned substance.

### Reversibility

Moderate. The ownership stance is a cross-project commitment, but the D1
boundary makes a later re-home low-cost: the engine and `AgentTier` seam would
move largely intact, since harness already leverages them by contract.

## Alternatives Considered

### Alternative 1: Harness-owned gate skill (that leverages canary)

Rejected for v1. This is the right home only if the gate machinery must be
*generic from day one*. It is not the v1 call: it puts the guardian upstream
(`Intense-Visions`), blocking v1 on external timing and review, and moves test
intelligence away from its domain owner — slowing iteration on exactly the part
that carries the value. The D1 boundary lets harness leverage the guardian later
without owning it, so nothing is lost by deferring.

### Alternative 2: Build both halves now (canary engine + harness host, split)

Rejected. Doubles the surface and demands upstream harness work immediately,
before the canary-side baseline has shipped or earned trust. Phasing — canary
owns v1, harness leverages later via the boundary — delivers the guarantee first
and defers the generic-host cost until a real need exists (YAGNI).

## Open Questions

None. The stance resolves to "canary owns the guardian; harness leverages it via
the ADR 0007 boundary and the #899 analyses contract," with the harness-hosted
tier deferred behind that seam.

## References

- `docs/changes/canary-pr-guardian/proposal.md` (Decision D2, Integration Points)
- ADR 0007 — Guardian agent capability boundary (the seam harness attaches to)
- `agent/guardian/analysis_emit.py` (`--emit-analysis`, the #899 producer)
- `docs/guides/harness-canary-integration.md` (disambiguation matrix)
- Upstream ask #899 — harness consuming canary's structured results
