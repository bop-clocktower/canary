"""SC-11 capability-boundary architecture test.

The Tier 0 deterministic engine (``agent/guardian/pr_check.py``,
``agent/guardian/coverage.py``, the comment poster ``agent/guardian/pr_comment.py``,
as of Phase 3 the tier-resolution seam ``agent/guardian/tier.py`` and the
pre-commit surface ``hooks/guardian_precommit.py``, and as of Phase 5 the
harness-handoff emit module ``agent/guardian/analysis_emit.py`` — deterministic
filesystem/JSON only) must stay **agent-free**: it
may import no ``AgentTier``, ``agent.llm``, or LLM-SDK module, and must never
reference the ``analyze_diff``/``get_impact`` MCP tools (those are the agent-tier
equivalents). The poster is deterministic HTTP behind a protocol seam, not an
agent; the tier probe is a Protocol whose Phase-3 impl (``NoAgentProbe``) reports
"no agent" deterministically without importing one.

RED proof (TDD): this test passes immediately on the clean modules, so to prove
it can fail, temporarily add ``import anthropic`` to the top of any scanned
module (e.g. ``agent/guardian/pr_comment.py``), run this file, and watch
``test_no_forbidden_imports`` fail; then remove the throwaway import and watch it
go green. That RED→GREEN cycle was performed during T13 (pr_check) and T7
(pr_comment) authoring, and again during Phase-3 T6 for ``tier.py`` and
``guardian_precommit.py`` (throwaway ``import anthropic`` added to each in turn,
watched fail, removed, watched go green), and again during Phase-5 T3 for
``analysis_emit.py`` (throwaway ``import anthropic`` added, watched
``test_no_forbidden_imports[analysis_emit.py]`` fail, removed, watched go green).
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MODULES = [
    _REPO_ROOT / "agent" / "guardian" / "pr_check.py",
    _REPO_ROOT / "agent" / "guardian" / "coverage.py",
    _REPO_ROOT / "agent" / "guardian" / "pr_comment.py",
    _REPO_ROOT / "agent" / "guardian" / "tier.py",  # + Phase 3 (SC-11)
    _REPO_ROOT / "hooks" / "guardian_precommit.py",  # + Phase 3 (SC-11)
    _REPO_ROOT / "agent" / "guardian" / "analysis_emit.py",  # + Phase 5 (SC-11)
]

# Module/symbol tokens the deterministic engine must never import.
_DENYLIST = (
    "agenttier",
    "agent.llm",
    "anthropic",
    "openai",
    "google.generativeai",
)
# MCP tool names that would breach the boundary if referenced.
_FORBIDDEN_REFS = ("analyze_diff", "get_impact")


def _import_tokens(tree: ast.AST) -> set[str]:
    """Collect every module string and imported symbol name from a parsed AST."""
    tokens: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                tokens.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            tokens.add(module)
            for alias in node.names:
                tokens.add(f"{module}.{alias.name}" if module else alias.name)
                tokens.add(alias.name)
    return tokens


def _code_identifiers(tree: ast.AST) -> set[str]:
    """Collect identifiers that appear in *executable code* — ``Name`` bindings,
    ``Attribute`` accessors, and imported symbols.

    Deliberately excludes string literals (docstrings) and comments, so the SC-11
    boundary note that *names* ``analyze_diff``/``get_impact`` in prose to say the
    engine does **not** use them is not a false positive.
    """
    idents: set[str] = _import_tokens(tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            idents.add(node.id)
        elif isinstance(node, ast.Attribute):
            idents.add(node.attr)
    return idents


def _is_agent_tier_token(token: str) -> bool:
    """True for an ``AgentTier``-style coupling of "agent" + "tier".

    Segment-aware so the *deterministic* seam ``agent.guardian.tier`` (guardian's
    own tier-resolution module, imported by ``hooks/guardian_precommit.py`` and
    ``agent/guardian/cli.py``) is NOT a false positive, while a real agent-tier
    import still trips: a single segment carrying both (``AgentTier``,
    ``agent_tier``, ``InSessionAgentTier``) or adjacent ``agent*`` → ``*tier*``
    segments (``agent.tier``, ``agent.tiers.AgentTier``). The intervening
    ``guardian`` segment is what distinguishes the legitimate seam from an agent
    tier.
    """
    segments = token.split(".")
    if any("agent" in seg and "tier" in seg for seg in segments):
        return True
    return any("agent" in a and "tier" in b for a, b in zip(segments, segments[1:]))


@pytest.mark.parametrize("module_path", _MODULES, ids=lambda p: p.name)
def test_no_forbidden_imports(module_path: Path) -> None:
    source = module_path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    tokens = {t.lower() for t in _import_tokens(tree)}
    for token in tokens:
        for banned in _DENYLIST:
            assert banned not in token, (
                f"{module_path.name} imports forbidden token '{token}' "
                f"(matched denylist '{banned}') — SC-11 boundary breach"
            )
        # Catch any *agent*tier* coupling beyond the literal token (but allow the
        # deterministic `agent.guardian.tier` seam — see `_is_agent_tier_token`).
        assert not _is_agent_tier_token(token), (
            f"{module_path.name} imports an agent-tier module '{token}' — SC-11"
        )


@pytest.mark.parametrize("module_path", _MODULES, ids=lambda p: p.name)
def test_no_mcp_tool_references(module_path: Path) -> None:
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    idents = _code_identifiers(tree)
    for ref in _FORBIDDEN_REFS:
        assert ref not in idents, (
            f"{module_path.name} references MCP tool '{ref}' in code — SC-11 "
            f"boundary breach (deterministic engine must not reach the agent tier)"
        )


# --- Phase 4: the ONE allowed orchestration module must itself stay LLM-free. --
#
# `agent_tier.py` is deliberately NOT in `_MODULES` (the Tier-0 boundary set) — it
# is the one place agent orchestration is permitted. But under Option A even IT
# must import no LLM SDK: it reaches agents only through the injected
# `AgentInvoker` port. These two tests pin both halves of SC-11.
#
# RED proof (TDD), performed during T6:
#   1. Add a throwaway `import anthropic` to the top of `agent_tier.py`, run this
#      file, watch `test_agent_tier_imports_no_llm_sdk` fail; remove it → green.
#   2. Add a throwaway `from agent.guardian import agent_tier` to
#      `hooks/guardian_precommit.py`, run this file, watch
#      `test_engine_still_excludes_agent_tier` (and the parametrized
#      `_is_agent_tier_token` scan in `test_no_forbidden_imports`) fail; remove
#      it → green.
_AGENT_TIER = _REPO_ROOT / "agent" / "guardian" / "agent_tier.py"
_LLM_SDK_DENYLIST = ("anthropic", "openai", "google.generativeai", "agent.llm")


def test_agent_tier_imports_no_llm_sdk() -> None:
    """agent_tier.py MAY define/reference the AgentInvoker port but must not
    import an LLM SDK directly (Option A: the SKILL/host session drives agents)."""
    tree = ast.parse(_AGENT_TIER.read_text(encoding="utf-8"))
    tokens = {t.lower() for t in _import_tokens(tree)}
    for token in tokens:
        for banned in _LLM_SDK_DENYLIST:
            assert banned not in token, (
                f"agent_tier.py imports LLM SDK '{token}' — Option A boundary breach"
            )


def test_engine_still_excludes_agent_tier() -> None:
    """The Tier-0 modules must not import agent_tier (belt-and-braces over the
    parametrized denylist)."""
    for module_path in _MODULES:
        tree = ast.parse(module_path.read_text(encoding="utf-8"))
        tokens = {t.lower() for t in _import_tokens(tree)}
        assert not any("agent_tier" in t for t in tokens), (
            f"{module_path.name} imports agent_tier — SC-11 breach"
        )
