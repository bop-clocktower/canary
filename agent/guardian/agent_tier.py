"""Agent-tier capability boundary for canary-pr-guardian (Phase 4).

This is the **one** module where agent orchestration is allowed — it sits
OUTSIDE the Tier-0 deterministic engine (``pr_check.py``/``coverage.py``/
``tier.py``), which imports it never (SC-11). Under the chosen **Option A**
invocation mechanism it **never calls an LLM directly**: it (i) turns
deterministic Tier-0 gaps into structured authoring intents, (ii) parses and
validates agent results into ``Finding``/``GeneratedTest`` records, and (iii)
enforces the write-safety model (opt-in, fork, collision, loop-guard) and the
block-once decision. It reaches an agent runtime only through an injected
``AgentInvoker`` **port**; the production default (``RecordingInvoker``) records
an intent and calls nothing, while the ``canary-pr-guardian`` SKILL fulfils it
in-session. A future ``CiAgentTier`` injects a real subprocess invoker without
touching this boundary or ``resolve_tier``.

SC-11 boundary: this module imports **no** LLM SDK
(``anthropic``/``openai``/``google.generativeai``/``agent.llm``). It is verified
by ``tests/unit/test_guardian_capability_boundary.py``:
``test_agent_tier_imports_no_llm_sdk``. RED proof performed during T6 — a
throwaway ``import anthropic`` here was watched to fail that test, then removed
and watched go green; and a throwaway ``from agent.guardian import agent_tier``
added to ``hooks/guardian_precommit.py`` was watched to fail
``test_engine_still_excludes_agent_tier``, then removed and watched go green.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import Finding  # Tier-0 type reuse (safe: no cycle)


@dataclass(frozen=True)
class ReviewRequest:
    """What Tier 1 asks ``canary-test-reviewer`` to audit (read-only)."""

    test_paths: list[Path]


@dataclass(frozen=True)
class GeneratedTest:
    """An authoring intent and its (eventual) result.

    v1 ``status``: ``'planned'`` (the ``RecordingInvoker`` default — the SKILL
    fulfils it in-session), ``'authored'`` (a fake/real invoker wrote it), or
    ``'skipped'`` (a safety guard blocked it, with ``skip_reason``).
    """

    gap: Finding
    target_path: str
    requirement: str  # NL requirement → /canary-write-test $ARGUMENTS
    status: str = "planned"  # planned | authored | skipped
    written_path: str | None = None
    skip_reason: str | None = None


@runtime_checkable
class AgentInvoker(Protocol):
    """Port to an agent runtime. Production default records; tests fake it."""

    def review(self, request: ReviewRequest) -> str:  # -> transcript
        ...

    def author(self, intent: GeneratedTest) -> GeneratedTest:  # -> authored
        ...


@dataclass(frozen=True)
class RecordingInvoker:
    """Default production invoker: calls NOTHING.

    Returns an empty transcript and a still-``planned`` intent so the SKILL
    fulfils the work in-session (Option A). This is what keeps the Python layer
    LLM-free.
    """

    def review(self, request: ReviewRequest) -> str:
        return ""  # nothing reviewed in Python; SKILL drives canary-test-reviewer

    def author(self, intent: GeneratedTest) -> GeneratedTest:
        return intent  # status stays 'planned'; SKILL drives canary-test-author


class AgentTier(Protocol):
    """The capability boundary a future ``CiAgentTier`` also implements."""

    def audit_test_quality(self, affected_tests: list[Path]) -> list[Finding]:
        ...

    def author_tests(self, gaps: list[Finding]) -> list[GeneratedTest]:
        ...


# A canary-test-reviewer transcript line: `[severity] path:line <message>`.
# The message tail is optional and captured as evidence.
_REVIEW_LINE_RE = re.compile(
    r"^\s*\[(?P<severity>[^\]]+)\]\s+(?P<path>\S+?):(?P<line>\d+)(?:\s+(?P<msg>.*))?$"
)

# Case-insensitive lookup of a reviewer severity token → the Tier-0 Severity enum.
_SEVERITY_BY_NAME = {s.value: s for s in Severity}


def _parse_review_findings(transcript: str) -> list[Finding]:
    """Parse ``canary-test-reviewer``'s ``[severity] path:line`` lines into
    ``weak-test`` Findings.

    A malformed line (no ``[severity] path:line`` shape) or an unknown severity
    token is skipped, never raised. An empty transcript (the ``RecordingInvoker``
    default) yields ``[]`` — the SKILL reports its review directly in-session.
    """
    findings: list[Finding] = []
    for raw in transcript.splitlines():
        match = _REVIEW_LINE_RE.match(raw)
        if match is None:
            continue
        severity = _SEVERITY_BY_NAME.get(match.group("severity").strip().lower())
        if severity is None:
            continue
        path = match.group("path")
        findings.append(
            Finding(
                path=path,
                unit=path,
                kind="weak-test",
                severity=severity,
                evidence=(match.group("msg") or "").strip(),
            )
        )
    return findings


@dataclass
class InSessionAgentTier:
    """v1 ``AgentTier``: drives ``canary-test-reviewer``/``-author`` via an
    injected invoker. Calls NO LLM itself (Option A) — the invoker is the port.
    """

    invoker: AgentInvoker = field(default_factory=RecordingInvoker)

    def audit_test_quality(self, affected_tests: list[Path]) -> list[Finding]:
        """Tier 1 (read-only): ask the reviewer to audit ``affected_tests`` and
        parse the transcript into ``weak-test`` Findings. Writes nothing."""
        transcript = self.invoker.review(ReviewRequest(list(affected_tests)))
        return _parse_review_findings(transcript)
