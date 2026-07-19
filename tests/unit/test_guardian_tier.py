"""Unit tests for the tier-resolution seam (SC-5 core).

`resolve_tier(requested, probe)` resolves a requested guardian tier against the
capability an agent runtime can actually serve. Phase 3 has no agent, so the
default `NoAgentProbe` caps the effective tier at 0 and any request above 0
degrades LOUDLY (never silently). The probe is a Protocol whose Phase-3 impl
imports no agent/LLM module (SC-11) — a local stub proves the seam does not
hardcode degradation, so Phase 4's real probe drops in unchanged.
"""

from __future__ import annotations

from agent.guardian.tier import NoAgentProbe, resolve_tier


class TestResolveTier:
    """SC-5: min(requested, available) with a loud notice iff it dropped."""

    def test_tier_zero_never_degrades(self) -> None:
        resolution = resolve_tier(0)
        assert resolution.requested == 0
        assert resolution.effective == 0
        assert resolution.degraded_notice is None

    def test_tier_one_degrades_loudly(self) -> None:
        resolution = resolve_tier(1)
        assert resolution.effective == 0
        assert resolution.degraded_notice is not None
        assert "tier 1" in resolution.degraded_notice
        assert "degraded" in resolution.degraded_notice

    def test_tier_two_degrades_loudly(self) -> None:
        resolution = resolve_tier(2)
        assert resolution.effective == 0
        assert resolution.degraded_notice is not None
        assert "tier 2" in resolution.degraded_notice
        assert "degraded" in resolution.degraded_notice

    def test_no_agent_probe_ceiling_is_zero(self) -> None:
        assert NoAgentProbe().available_tier() == 0

    def test_capable_probe_serves_requested_without_notice(self) -> None:
        # Future-proofing: a probe that reports tier 2 lets resolve_tier serve it
        # with NO degradation — proving the seam does not hardcode degradation.
        class _Probe2:
            def available_tier(self) -> int:
                return 2

        resolution = resolve_tier(2, _Probe2())
        assert resolution.effective == 2
        assert resolution.degraded_notice is None

    def test_capable_probe_still_degrades_above_ceiling(self) -> None:
        # A probe serving tier 1 caps a tier-2 request at 1, loudly.
        class _Probe1:
            def available_tier(self) -> int:
                return 1

        resolution = resolve_tier(2, _Probe1())
        assert resolution.effective == 1
        assert resolution.degraded_notice is not None
        assert "tier 2" in resolution.degraded_notice
