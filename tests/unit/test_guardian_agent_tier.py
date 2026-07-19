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

from agent.guardian.agent_tier import (
    AgentInvoker,
    GeneratedTest,
    RecordingInvoker,
    ReviewRequest,
)
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
