"""Tier-resolution seam for canary-pr-guardian (SC-5 core).

Resolves a *requested* guardian tier against the tier an agent runtime can
actually serve, and emits a **loud** degradation notice whenever the effective
tier drops below the request. The capability probe is a ``typing.Protocol``; the
Phase-3 default (:class:`NoAgentProbe`) deterministically reports "no agent"
(tier 0 ceiling) **without importing any agent/LLM module** (SC-11, enforced by
``test_guardian_capability_boundary.py``). Phase 4 supplies a real probe
implementing the same Protocol — ``resolve_tier``'s callers do not change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


def _degradation_notice(requested: int, effective: int) -> str:
    """Canonical loud degradation notice (D6 / SC-5).

    Names the requested tier and stays loud — a tier>0 result must never be
    surfaced without this notice when the requested tier is unavailable.
    """
    return (
        f"⚠ degraded: tier {requested} unavailable "
        f"(no agent runtime detected) — ran tier {effective}"
    )


class AgentCapabilityProbe(Protocol):
    """Reports the highest tier an agent runtime can serve.

    Phase 3 has none; Phase 4 supplies a real probe (e.g. ``InSessionAgentProbe``)
    implementing this same Protocol so ``resolve_tier``'s callers do not change.
    """

    def available_tier(self) -> int:  # pragma: no cover - Protocol signature
        ...


@dataclass(frozen=True)
class NoAgentProbe:
    """Deterministic Phase-3 probe: no agent runtime, so tier 0 is the ceiling.

    Imports no agent/LLM module (SC-11).
    """

    def available_tier(self) -> int:
        return 0


@dataclass(frozen=True)
class TierResolution:
    """The outcome of resolving a requested tier against available capability."""

    requested: int
    effective: int
    degraded_notice: str | None


def resolve_tier(
    requested: int, probe: AgentCapabilityProbe | None = None
) -> TierResolution:
    """Resolve ``requested`` against the probe's ceiling, degrading loudly.

    ``probe`` defaults to :class:`NoAgentProbe`. The effective tier is
    ``min(requested, probe.available_tier())``; a loud :func:`_degradation_notice`
    is attached iff the effective tier is below the request (else ``None``).
    """
    active_probe = probe if probe is not None else NoAgentProbe()
    available = active_probe.available_tier()
    effective = min(requested, available)
    notice = (
        _degradation_notice(requested, effective) if effective < requested else None
    )
    return TierResolution(
        requested=requested, effective=effective, degraded_notice=notice
    )
