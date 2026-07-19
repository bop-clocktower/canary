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

from agent.guardian.agent_tier import (
    AgentInvoker,
    GeneratedTest,
    InSessionAgentTier,
    RecordingInvoker,
    ReviewRequest,
)
from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import Finding


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
