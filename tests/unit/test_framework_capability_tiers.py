"""TDD for framework capability tiers — honest, code-derived support levels.

The registry advertises many frameworks, but canary's real support per
framework varies. `FrameworkRegistry.capabilities()` derives an honest tier
from what the code can actually do (scaffold template? runnable execution
command?) rather than the registry's subjective status/maturity prose.

The drift-guard tests keep the registry and the code from silently diverging —
the roadmap's explicit "derive tiers from the registry, don't hand-maintain a
matrix" requirement.
"""

from __future__ import annotations

from agent.core.framework_registry import FrameworkRegistry


class TestCapabilityDerivation:
    def setup_method(self) -> None:
        self.reg = FrameworkRegistry()

    def test_full_tier_has_scaffold_and_execute(self) -> None:
        # pytest has a scaffold template AND a runnable execution command.
        caps = self.reg.capabilities("pytest")
        assert caps is not None
        assert caps["scaffold"] is True
        assert caps["execute"] is True
        assert caps["tier"] == "full"

    def test_executable_tier_execute_without_scaffold(self) -> None:
        # schemathesis is in the registry with a runnable command but has no
        # scaffold template — canary can run it, not set it up.
        caps = self.reg.capabilities("schemathesis")
        assert caps is not None
        assert caps["execute"] is True
        assert caps["scaffold"] is False
        assert caps["tier"] == "executable"

    def test_catalog_tier_no_execution(self) -> None:
        # tosca is listed for detection/recommendation but has no execution
        # command — canary cannot run it.
        caps = self.reg.capabilities("tosca")
        assert caps is not None
        assert caps["execute"] is False
        assert caps["scaffold"] is False
        assert caps["tier"] == "catalog"

    def test_unrunnable_placeholder_is_not_executable(self) -> None:
        # zap/semgrep carry a {target} placeholder the executor never
        # substitutes ({file} only). A plausible-looking-but-unrunnable command
        # must NOT be advertised as executable — that would overpromise.
        for name in ("zap", "semgrep"):
            caps = self.reg.capabilities(name)
            assert caps is not None, name
            assert caps["execute"] is False, name
            assert caps["tier"] == "catalog", name

    def test_whole_suite_runner_is_executable(self) -> None:
        # A no-placeholder suite runner (stryker) runs as-is — the executor
        # needs no substitution, so it is genuinely runnable.
        caps = self.reg.capabilities("stryker")
        assert caps is not None
        assert caps["execute"] is True

    def test_capabilities_is_case_insensitive(self) -> None:
        # capabilities() must agree with Scaffolder.scaffold(), which lowercases.
        assert self.reg.capabilities("Pytest") == self.reg.capabilities("pytest")

    def test_unknown_framework_returns_none(self) -> None:
        assert self.reg.capabilities("nonexistent") is None
        assert self.reg.capabilities("") is None


class TestSummariesExposeTier:
    def test_every_summary_carries_a_valid_tier(self) -> None:
        reg = FrameworkRegistry()
        summaries = reg.summaries()
        assert summaries
        for s in summaries:
            assert s["tier"] in {"full", "executable", "catalog"}
            caps = s["capabilities"]
            assert set(caps) == {"scaffold", "execute", "tier"}


class TestDriftGuard:
    """Fail if the registry and the capability-providing code diverge."""

    def setup_method(self) -> None:
        self.reg = FrameworkRegistry()
        self.names = {f["name"] for f in self.reg.get_all_frameworks()}

    def test_every_scaffold_template_is_a_real_framework(self) -> None:
        # An orphan template (no registry entry) means canary can scaffold a
        # framework it won't admit exists — a silent inconsistency.
        from agent.core.scaffolder import scaffoldable_frameworks

        orphans = scaffoldable_frameworks() - self.names
        assert not orphans, f"scaffold templates with no registry entry: {orphans}"

    def test_capabilities_resolves_for_every_registered_framework(self) -> None:
        # No registry entry may be un-tierable — every advertised framework must
        # produce an honest capability verdict.
        for name in self.names:
            caps = self.reg.capabilities(name)
            assert caps is not None, f"{name} has no derivable capabilities"
            assert caps["tier"] in {"full", "executable", "catalog"}

    def test_scaffoldable_implies_executable(self) -> None:
        # The tier mapping has no name for "scaffold but can't run", and it
        # would be nonsensical (why bootstrap what canary can't execute?). Pin
        # the invariant: if it ever breaks, the tier logic needs a real
        # decision rather than silently bucketing it as `catalog`.
        for name in self.names:
            caps = self.reg.capabilities(name)
            if caps["scaffold"]:
                assert caps["execute"], (
                    f"{name} is scaffoldable but not runnable — tier logic needs "
                    "an explicit case for this quadrant"
                )
