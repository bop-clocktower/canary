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

import os
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

    def author_tests(
        self, gaps: list[Finding], ctx: AuthoringContext | None = None
    ) -> list[GeneratedTest]:
        """Tier 2: plan the safe authoring intents, then hand each ``planned``
        intent to the injected invoker (the ``RecordingInvoker`` default leaves
        it ``planned`` — Option A; a fake/real invoker returns ``authored``).
        ``skipped`` records pass through untouched. Absent ``ctx`` the caller
        gets the fail-closed default (opt-in off, tier 0 → everything skipped)."""
        plan = plan_authoring(gaps, ctx or AuthoringContext(False, 0))
        out: list[GeneratedTest] = []
        for intent in plan:
            if intent.status == "planned":
                out.append(self.invoker.author(intent))  # -> authored (fake/real)
            else:
                out.append(intent)  # skipped, unchanged
        return out


@dataclass(frozen=True)
class InSessionAgentProbe:
    """Reports the agent tier ceiling from an explicit opt-in signal.

    Reads env ``CANARY_GUARDIAN_AGENT`` (``0|1|2``), which the SKILL exports when
    it runs in-session. Unset or invalid → ``0`` (so CI, where the env is unset,
    stays Tier-0). Returns an ``int`` only — imports no LLM (SC-11), so it drops
    into ``resolve_tier`` unchanged as the real ``AgentCapabilityProbe``.
    """

    def available_tier(self) -> int:
        raw = os.environ.get("CANARY_GUARDIAN_AGENT", "0")
        return int(raw) if raw in {"0", "1", "2"} else 0


# --- Tier-2 authoring safety model (D4 guards a–d) — pure, writes nothing. ----

# Language-specific test-path templates (peer-layout mirror).
_TS_JS_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"}


@dataclass(frozen=True)
class AuthoringContext:
    """Everything ``plan_authoring`` needs to apply the four safety guards.

    All fields are supplied by the caller (the ``author-plan`` CLI seam in T7);
    this keeps the guards pure and deterministic.
    """

    author_tests_optin: bool  # config.precommit_author_tests (default False) — (d)
    effective_tier: int  # from resolve_tier (2 == can author)
    is_fork: bool = False  # reuse Phase-2 fork/403 detection — (b)
    repo_root: Path = field(default_factory=lambda: Path("."))
    authored_sentinel_present: bool = False  # loop-guard — (a)


def _target_test_path(gap: Finding) -> str:
    """Deterministic target test path for a gap, mirroring peer test layout.

    - ``.py`` source → ``{parent}/test_{stem}.py`` (pytest convention);
    - TS/JS source → ``{parent}/{stem}.test{suffix}`` (jest/vitest convention);
    - anything else → ``{parent}/{stem}.test{suffix}`` as a safe default.

    Returns a repo-relative POSIX path string.
    """
    src = Path(gap.path)
    parent = src.parent
    if src.suffix == ".py":
        target = parent / f"test_{src.stem}.py"
    elif src.suffix in _TS_JS_SUFFIXES:
        target = parent / f"{src.stem}.test{src.suffix}"
    else:
        target = parent / f"{src.stem}.test{src.suffix or ''}"
    return target.as_posix()


def _requirement_for(gap: Finding) -> str:
    """NL requirement string the ``/canary-write-test`` command consumes as
    ``$ARGUMENTS`` — names the unit and the untested change."""
    return (
        f"Write tests for `{gap.unit}` in `{gap.path}` covering the newly added, "
        f"currently-untested code (guardian finding: {gap.kind})."
    )


def _authoring_skip_reason(gap: Finding, ctx: AuthoringContext) -> str | None:
    """Return the first failing guard's reason, or ``None`` if all guards pass.

    Guard order (fail-closed, cheapest/broadest first): (d) opt-in, (d) tier,
    (b) fork, (a) loop-guard, (c) collision.
    """
    if not ctx.author_tests_optin:
        return "opt-in: preCommit.authorTests is not enabled — authoring is off by default"
    if ctx.effective_tier < 2:
        return f"tier: effective tier {ctx.effective_tier} < 2 — cannot author"
    if ctx.is_fork:
        return "fork: read-only — guardian never writes on a fork PR"
    if ctx.authored_sentinel_present:
        return "loop-guard: guardian tests already authored this run — not re-authoring"
    target = ctx.repo_root / _target_test_path(gap)
    if target.exists():
        return f"collision: {_target_test_path(gap)} exists — another PR/session may own it"
    return None


def plan_authoring(
    gaps: list[Finding], ctx: AuthoringContext
) -> list[GeneratedTest]:
    """Apply the four D4 guards and emit one ``GeneratedTest`` per gap.

    A gap that clears every guard becomes a ``planned`` intent (non-empty
    ``requirement`` + ``target_path``); any guard failure becomes a ``skipped``
    record carrying the reason. Pure — reads disk only to detect collisions
    (guard c) and writes **nothing**.
    """
    out: list[GeneratedTest] = []
    for gap in gaps:
        target = _target_test_path(gap)
        requirement = _requirement_for(gap)
        reason = _authoring_skip_reason(gap, ctx)
        if reason is None:
            out.append(
                GeneratedTest(
                    gap=gap,
                    target_path=target,
                    requirement=requirement,
                    status="planned",
                )
            )
        else:
            out.append(
                GeneratedTest(
                    gap=gap,
                    target_path=target,
                    requirement=requirement,
                    status="skipped",
                    skip_reason=reason,
                )
            )
    return out


@dataclass(frozen=True)
class BlockDecision:
    """The pre-commit block-once decision computed from an authoring run."""

    block: bool
    message: str
    authored_count: int


def decide_block(results: list[GeneratedTest]) -> BlockDecision:
    """Block the commit ONCE iff ≥1 ACTIONABLE (non-``skipped``) intent this run.

    Under Option A the production ``RecordingInvoker`` leaves every intent
    ``planned`` — the SKILL then authors each non-``skipped`` intent in-session —
    so blocking only on ``authored`` would never gate the real path (the bug FIX 1
    fixes). An intent is actionable when its ``status != "skipped"`` (``planned``
    OR ``authored``); an all-``skipped`` run changed nothing, so it never blocks.
    ``authored_count`` counts those actionable intents (the field name the
    CLI/JSON/SKILL read). The message instructs "review … then re-commit" (D4);
    the actual sentinel write + ``git add`` happen in the hook/SKILL — this is pure
    decision logic.
    """
    actionable = [r for r in results if r.status != "skipped"]
    count = len(actionable)
    if count == 0:
        return BlockDecision(block=False, message="", authored_count=0)
    message = (
        f"⛔ canary-guardian: {count} test(s) authored & staged — "
        f"review the generated code, then re-commit."
    )
    return BlockDecision(block=True, message=message, authored_count=count)
