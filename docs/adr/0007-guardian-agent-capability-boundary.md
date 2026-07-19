# ADR 0007 — Guardian agent capability boundary (agentless-in-CI, agent-at-desk)

**Status:** accepted
**Date:** 2026-07-19
**Deciders:** Bri Stevenski (upstream maintainer)
**Related:** #312; `docs/changes/canary-pr-guardian/proposal.md` (Decision D1)

## Context

`canary-pr-guardian` runs a per-change test-quality loop: scope a diff,
determine whether the new/changed code is tested, audit the quality of the
affected tests, and — where a runtime exists — author the missing tests. Its
must-have value is a ranked, fidelity-labeled findings comment on **every**
pull request.

The complication is runtime. The high-value tiers (LLM test-quality audit,
LLM test authoring) need a Claude-compatible agent runtime. This repo has no
LLM-in-CI runtime today: no workflow carries an API key or an agent runner, and
standing one up brings the sharpest safety edges (write tokens on PR branches,
cost, secret management, loop-guards) before the baseline has earned any trust.

At the same time, an agent runtime *does* exist where developers work — the
in-session/pre-commit desk. So the guardian must deliver a guaranteed baseline
with zero new infra, while leaving a clean seam for a future CI-agent runner to
host the higher tiers unchanged.

## Decision

The guardian is split across an explicit **capability boundary** (D1):

- **Tier 0 runs agentless in CI.** The deterministic engine
  (`agent/guardian/pr_check.py` + `agent/guardian/coverage.py`) parses the diff,
  resolves coverage via the fidelity ladder (coverage-report › graph ›
  heuristic), renders findings, and upserts the sticky PR comment. It runs on
  stock GitHub Actions with **no agent, no secret, and no write token** — so the
  baseline (findings on every PR) is guaranteed.
- **Tiers 1/2 engage only at the desk in v1.** The LLM test-quality audit
  (Tier 1, via `canary-review-test`) and test authoring (Tier 2/desk, via
  `canary-write-test`) run wherever a runtime already lives — the developer's
  session or the pre-commit hook.
- **The two halves meet at an `AgentTier` capability interface**
  (`agent/guardian/agent_tier.py`). `InSessionAgentTier` implements it for v1;
  a future `CiAgentTier` (a runner) can implement the same protocol to host the
  agent tiers in CI **without a redesign**. The Tier 0 engine never imports
  `AgentTier` or any agent/LLM module — the boundary is one-directional.

This boundary is enforced mechanically: an AST/import test
(`tests/unit/test_guardian_capability_boundary.py`, SC-11) asserts that the
deterministic engine imports nothing from the agent tier, so the guaranteed
baseline can never silently acquire an agent dependency.

## Consequences

### Immediate

- The agentless Tier 0 pass is the CI baseline for every consumer, with zero new
  infrastructure. A repo with no runtime still gets fidelity-labeled findings on
  every PR.
- Opting into a tier whose runtime is absent degrades **loudly** (D6): Tier 0
  runs and a `⚠ degraded: tier N unavailable — ran tier 0` notice is emitted —
  never a silent under-delivery.
- The import boundary is a hard, tested invariant. A change that couples the
  engine to the agent tier fails CI, not code review.

### Follow-on

- A future CI-agent runner attaches by implementing `AgentTier` (`CiAgentTier`)
  — no change to the Tier 0 engine, the workflow's deterministic step, or the
  finding shape. The seam was shaped *after* the deterministic surfaces shipped
  (Phase 4 followed Phases 1–3), so it reflects real Tier-0 behavior rather than
  a guess.

### Risks

- **A future contributor may be tempted to "just import" an agent helper into
  the engine** for convenience. Mitigation: SC-11's import test blocks it in CI.
- **Desk-only Tiers 1/2 mean CI never audits test *quality* in v1** — only
  presence/coverage. Mitigation: this is an accepted v1 non-goal; the boundary
  makes adding it later additive, not a rewrite.

### Reversibility

High. The boundary is purely additive to the deterministic core — adding a CI
agent tier extends the `AgentTier` implementations without touching Tier 0.

## Alternatives Considered

### Alternative 1: Stand up a canary CI-agent runner now (agent-in-CI)

Rejected. There is no LLM-in-CI runtime in this repo, and building one brings
the largest surface and sharpest safety edges — write tokens, secrets, cost,
fork/concurrency loop-guards — *before* the deterministic baseline has earned
trust. Deferred until a runner exists; the `AgentTier` seam lets it land without
a redesign.

### Alternative 2: No boundary — one integrated skill

Rejected. Collapsing Tier 0 and the agent tiers into one component couples the
*guaranteed* baseline to the LLM: every CI run would then need an agent runtime,
defeating goal #1 (agentless findings on every PR). The explicit boundary keeps
the guarantee independent of the LLM.

### Alternative 3: Depend on harness `review-ci`

Rejected for v1. It would put the baseline behind an upstream, generic gate
before canary's own deterministic pass exists. See ADR 0008 for the ownership
rationale.

## Open Questions

None. The boundary resolves cleanly to "agentless Tier 0 in CI, agent tiers at
the desk behind `AgentTier`," with the CI-agent tier deferred behind the same
seam.

## References

- `docs/changes/canary-pr-guardian/proposal.md` (Decision D1, Tier ladder)
- `agent/guardian/pr_check.py`, `agent/guardian/coverage.py` (Tier 0 engine)
- `agent/guardian/agent_tier.py` (`AgentTier` boundary)
- `tests/unit/test_guardian_capability_boundary.py` (SC-11 enforcement)
- ADR 0008 — Guardian ownership (canary-owned, harness-leveraged)
