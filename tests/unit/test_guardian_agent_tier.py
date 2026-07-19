"""Unit tests for the agent-tier capability boundary (Phase 4).

`agent/guardian/agent_tier.py` is the ONE module where agent orchestration is
allowed. Under Option A it NEVER calls an LLM — it plans authoring intents,
parses agent transcripts, and enforces the write-safety model, reaching agents
only through an injected ``AgentInvoker`` port. Every test here drives that port
with a local ``FakeInvoker`` (or the default ``RecordingInvoker``) — no real
agent/LLM/network is ever touched, and the read-only/planning paths write
nothing to disk (asserted via ``tmp_path``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.guardian.agent_tier import (
    AgentInvoker,
    AuthoringContext,
    GeneratedTest,
    InSessionAgentProbe,
    InSessionAgentTier,
    RecordingInvoker,
    ReviewRequest,
    _target_test_path,
    decide_block,
    plan_authoring,
)
from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import Finding
from agent.guardian.tier import resolve_tier


def _finding(path: str = "src/foo.py", unit: str = "foo") -> Finding:
    """A minimal Tier-0 ``untested-new-code`` finding for author/audit tests."""
    return Finding(path=path, unit=unit)


class FakeInvoker:
    """Test double satisfying the ``AgentInvoker`` port. Calls nothing real.

    ``review_transcript`` is returned verbatim from :meth:`review`; :meth:`author`
    marks an intent ``authored`` with a ``written_path`` so parse/stage/block
    logic is exercised without an agent.
    """

    def __init__(self, review_transcript: str = "") -> None:
        self.review_transcript = review_transcript
        self.review_calls: list[ReviewRequest] = []
        self.author_calls: list[GeneratedTest] = []

    def review(self, request: ReviewRequest) -> str:
        self.review_calls.append(request)
        return self.review_transcript

    def author(self, intent: GeneratedTest) -> GeneratedTest:
        self.author_calls.append(intent)
        from dataclasses import replace

        return replace(intent, status="authored", written_path=intent.target_path)


class TestFoundation:
    """T1: the Protocol, port, and record types are pure and LLM-free."""

    def test_generated_test_defaults(self) -> None:
        gen = GeneratedTest(gap=_finding(), target_path="t", requirement="r")
        assert gen.status == "planned"
        assert gen.written_path is None
        assert gen.skip_reason is None

    def test_recording_invoker_reviews_nothing(self) -> None:
        assert RecordingInvoker().review(ReviewRequest([])) == ""

    def test_recording_invoker_author_stays_planned(self) -> None:
        intent = GeneratedTest(gap=_finding(), target_path="t", requirement="r")
        result = RecordingInvoker().author(intent)
        assert isinstance(result, GeneratedTest)
        assert result.status == "planned"
        assert result.written_path is None

    def test_recording_invoker_satisfies_port(self) -> None:
        assert isinstance(RecordingInvoker(), AgentInvoker)

    def test_fake_invoker_satisfies_port(self) -> None:
        assert isinstance(FakeInvoker(), AgentInvoker)


class TestAuditTestQuality:
    """T2: Tier-1 read-only audit → parse transcript into weak-test Findings."""

    def test_parses_transcript_into_weak_test_findings(self) -> None:
        invoker = FakeInvoker(
            review_transcript=(
                "[Critical] tests/foo_test.py:12 assertion is tautological\n"
                "[medium] tests/bar_test.py:4 missing negative case\n"
            )
        )
        tier = InSessionAgentTier(invoker=invoker)
        findings = tier.audit_test_quality([Path("tests/foo_test.py")])

        assert len(findings) == 2
        assert all(f.kind == "weak-test" for f in findings)
        first = findings[0]
        assert first.path == "tests/foo_test.py"
        assert first.severity is Severity.CRITICAL
        # The invoker was actually consulted through the port.
        assert invoker.review_calls
        assert invoker.review_calls[0].test_paths == [Path("tests/foo_test.py")]

    def test_default_recording_invoker_audits_nothing(self, tmp_path: Path) -> None:
        # RecordingInvoker returns "" → no findings; the SKILL reports directly.
        before = set(tmp_path.iterdir())
        tier = InSessionAgentTier()  # default RecordingInvoker
        findings = tier.audit_test_quality([tmp_path / "some_test.py"])
        assert findings == []
        # Read-only: nothing written to disk.
        assert set(tmp_path.iterdir()) == before

    def test_malformed_lines_are_skipped_not_crashing(self) -> None:
        invoker = FakeInvoker(
            review_transcript=(
                "this is not a finding line\n"
                "[Critical] tests/foo_test.py:12 real one\n"
                "[bogus-severity] tests/x_test.py:1 unknown severity\n"
                "\n"
            )
        )
        tier = InSessionAgentTier(invoker=invoker)
        findings = tier.audit_test_quality([Path("tests/foo_test.py")])
        # Only the well-formed, known-severity line survives.
        assert len(findings) == 1
        assert findings[0].path == "tests/foo_test.py"
        assert findings[0].severity is Severity.CRITICAL


class TestInSessionAgentProbe:
    """T3 / SC-5 regression: real probe lifts degradation when present, stays
    loud when absent. Reads env only — no LLM import, no real agent."""

    def test_env_unset_ceiling_zero_and_degrades(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("CANARY_GUARDIAN_AGENT", raising=False)
        probe = InSessionAgentProbe()
        assert probe.available_tier() == 0
        resolution = resolve_tier(2, probe)
        assert resolution.effective == 0
        assert resolution.degraded_notice is not None
        assert "tier 2" in resolution.degraded_notice

    def test_tier_two_present_no_false_degradation(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "2")
        probe = InSessionAgentProbe()
        assert probe.available_tier() == 2
        resolution = resolve_tier(2, probe)
        assert resolution.effective == 2
        assert resolution.degraded_notice is None

    def test_tier_one_present_caps_two_loudly_serves_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", "1")
        probe = InSessionAgentProbe()
        assert probe.available_tier() == 1
        capped = resolve_tier(2, probe)
        assert capped.effective == 1
        assert capped.degraded_notice is not None
        assert "tier 2" in capped.degraded_notice
        served = resolve_tier(1, probe)
        assert served.effective == 1
        assert served.degraded_notice is None

    @pytest.mark.parametrize("garbage", ["9", "x", "", "-1", "1.0"])
    def test_garbage_value_is_zero(
        self, monkeypatch: pytest.MonkeyPatch, garbage: str
    ) -> None:
        monkeypatch.setenv("CANARY_GUARDIAN_AGENT", garbage)
        assert InSessionAgentProbe().available_tier() == 0


class TestPlanAuthoring:
    """T4 / D4: the four safety guards, pure — writes nothing, emits intents or
    skip-records with a reason. ``repo_root`` is ``tmp_path`` so collision checks
    hit real (test-owned) disk without touching the repo."""

    def _ok_ctx(self, tmp_path: Path) -> AuthoringContext:
        """Opt-in on, tier 2, not fork, no sentinel — the authorable context."""
        return AuthoringContext(
            author_tests_optin=True,
            effective_tier=2,
            is_fork=False,
            repo_root=tmp_path,
            authored_sentinel_present=False,
        )

    def test_guard_d_opt_in_off_skips_all(self, tmp_path: Path) -> None:
        ctx = AuthoringContext(
            author_tests_optin=False, effective_tier=2, repo_root=tmp_path
        )
        results = plan_authoring([_finding()], ctx)
        assert [r.status for r in results] == ["skipped"]
        assert "opt-in" in (results[0].skip_reason or "")

    def test_guard_d_tier_below_two_skips(self, tmp_path: Path) -> None:
        ctx = AuthoringContext(
            author_tests_optin=True, effective_tier=1, repo_root=tmp_path
        )
        results = plan_authoring([_finding()], ctx)
        assert results[0].status == "skipped"
        assert "tier" in (results[0].skip_reason or "")

    def test_guard_b_fork_skips_all(self, tmp_path: Path) -> None:
        ctx = AuthoringContext(
            author_tests_optin=True,
            effective_tier=2,
            is_fork=True,
            repo_root=tmp_path,
        )
        results = plan_authoring([_finding()], ctx)
        assert all(r.status == "skipped" for r in results)
        assert "fork" in (results[0].skip_reason or "")

    def test_guard_a_sentinel_skips_all(self, tmp_path: Path) -> None:
        ctx = AuthoringContext(
            author_tests_optin=True,
            effective_tier=2,
            repo_root=tmp_path,
            authored_sentinel_present=True,
        )
        results = plan_authoring([_finding()], ctx)
        assert all(r.status == "skipped" for r in results)
        assert "already authored" in (results[0].skip_reason or "")

    def test_guard_c_collision_when_target_exists(self, tmp_path: Path) -> None:
        gap = _finding(path="src/foo.py", unit="foo")
        target = tmp_path / _target_test_path(gap)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# pre-existing test from another PR\n", encoding="utf-8")
        results = plan_authoring([gap], self._ok_ctx(tmp_path))
        assert results[0].status == "skipped"
        assert "collision" in (results[0].skip_reason or "") or "exists" in (
            results[0].skip_reason or ""
        )

    def test_happy_path_emits_one_planned_intent_per_gap(
        self, tmp_path: Path
    ) -> None:
        before = set(tmp_path.rglob("*"))
        gaps = [
            _finding(path="src/foo.py", unit="foo"),
            _finding(path="src/bar.py", unit="bar"),
        ]
        results = plan_authoring(gaps, self._ok_ctx(tmp_path))
        assert [r.status for r in results] == ["planned", "planned"]
        for r in results:
            assert r.requirement.strip()
            assert r.target_path.strip()
            assert r.skip_reason is None
        # Pure planning: nothing written to disk.
        assert set(tmp_path.rglob("*")) == before


class TestAuthorTests:
    """T5 / SC-6: wire plan_authoring to the injected invoker → authored records
    for authorable gaps, skipped records preserved. No real agent/LLM/network."""

    def _ok_ctx(self, tmp_path: Path) -> AuthoringContext:
        return AuthoringContext(
            author_tests_optin=True, effective_tier=2, repo_root=tmp_path
        )

    def test_fake_invoker_authors_planned_preserves_skipped(
        self, tmp_path: Path
    ) -> None:
        authorable = _finding(path="src/foo.py", unit="foo")
        colliding = _finding(path="src/bar.py", unit="bar")
        # Pre-create the colliding gap's target so guard (c) skips it.
        target = tmp_path / _target_test_path(colliding)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# owned by another PR\n", encoding="utf-8")

        invoker = FakeInvoker()
        tier = InSessionAgentTier(invoker=invoker)
        results = tier.author_tests([authorable, colliding], self._ok_ctx(tmp_path))

        by_path = {r.gap.path: r for r in results}
        assert by_path["src/foo.py"].status == "authored"
        assert by_path["src/foo.py"].written_path == _target_test_path(authorable)
        assert by_path["src/bar.py"].status == "skipped"
        # Only planned intents were sent to the invoker (one authorable gap).
        assert len(invoker.author_calls) == 1
        assert invoker.author_calls[0].gap.path == "src/foo.py"

    def test_default_recording_invoker_authors_nothing(self, tmp_path: Path) -> None:
        tier = InSessionAgentTier()  # default RecordingInvoker (Option A)
        results = tier.author_tests([_finding()], self._ok_ctx(tmp_path))
        assert [r.status for r in results] == ["planned"]
        assert results[0].written_path is None


class TestDecideBlock:
    """T5 / D4: block ONCE iff ≥1 test was authored this run; never on all-skip."""

    def _authored(self) -> GeneratedTest:
        return GeneratedTest(
            gap=_finding(),
            target_path="tests/test_foo.py",
            requirement="r",
            status="authored",
            written_path="tests/test_foo.py",
        )

    def _skipped(self) -> GeneratedTest:
        return GeneratedTest(
            gap=_finding(),
            target_path="tests/test_foo.py",
            requirement="r",
            status="skipped",
            skip_reason="fork: read-only",
        )

    def _planned(self) -> GeneratedTest:
        return GeneratedTest(
            gap=_finding(),
            target_path="tests/test_foo.py",
            requirement="r",
            status="planned",
        )

    def test_blocks_once_when_tests_authored(self) -> None:
        decision = decide_block([self._authored(), self._authored()])
        assert decision.block is True
        assert decision.authored_count == 2
        assert "authored & staged" in decision.message
        assert "re-commit" in decision.message

    def test_blocks_on_planned_actionable_intents(self) -> None:
        # FIX 1 (production path): under Option A the default RecordingInvoker
        # leaves intents ``planned`` — the SKILL authors every non-skipped intent,
        # so a planned intent is ACTIONABLE and must block (not only "authored").
        decision = decide_block([self._planned(), self._planned()])
        assert decision.block is True
        assert decision.authored_count == 2
        assert "review" in decision.message
        assert "re-commit" in decision.message

    def test_blocks_on_planned_plus_skipped_counts_actionable_only(self) -> None:
        decision = decide_block([self._planned(), self._skipped()])
        assert decision.block is True
        assert decision.authored_count == 1

    def test_does_not_block_on_all_skipped(self) -> None:
        decision = decide_block([self._skipped(), self._skipped()])
        assert decision.block is False
        assert decision.authored_count == 0

    def test_blocks_on_mixed_counting_only_authored(self) -> None:
        decision = decide_block([self._authored(), self._skipped()])
        assert decision.block is True
        assert decision.authored_count == 1
