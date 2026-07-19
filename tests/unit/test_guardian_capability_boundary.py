"""SC-11 capability-boundary architecture test.

The Tier 0 deterministic engine (``agent/guardian/pr_check.py``,
``agent/guardian/coverage.py``, and — as of Phase 2 — the comment poster
``agent/guardian/pr_comment.py``) must stay **agent-free**: it may import no
``AgentTier``, ``agent.llm``, or LLM-SDK module, and must never reference the
``analyze_diff``/``get_impact`` MCP tools (those are the agent-tier equivalents).
The poster is deterministic HTTP behind a protocol seam, not an agent.

RED proof (TDD): this test passes immediately on the clean modules, so to prove
it can fail, temporarily add ``import anthropic`` to the top of any scanned
module (e.g. ``agent/guardian/pr_comment.py``), run this file, and watch
``test_no_forbidden_imports`` fail; then remove the throwaway import and watch it
go green. That RED→GREEN cycle was performed during T13 (pr_check) and T7
(pr_comment) authoring.
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
        # Catch any *agent*tier* pattern beyond the literal token.
        assert not ("agent" in token and "tier" in token), (
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
