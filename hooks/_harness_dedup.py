#!/usr/bin/env python3
"""Shared dedup guard for canary's plugin hooks.

Canary ships Python hooks (wired via ``.claude-plugin/hooks.json``) that overlap
with harness's JS hooks (wired via ``.claude/settings.json``). When both the
canary plugin *and* harness are active in the same project, each overlapping
hook fires twice — ``block-no-verify``, ``protect-config``, ``pre-compact-state``
run in both languages, and every Edit/Write triggers both ``quality-gate.py``
(ruff) and ``quality-warner.js`` (format-check).

Single source of truth: the harness JS hooks stay authoritative for the
overlapping surfaces (they were hardened in PR #306). Each canary Python hook
calls :func:`harness_hook_present` and defers (no-ops) when its harness
counterpart is wired, so the same policy is enforced exactly once. Hooks that
own *unique* surface (e.g. protect-config's Python-only configs, quality-gate's
per-file ruff when ruff config lives in pyproject.toml) defer only the
overlapping slice and keep doing their unique work.

"Present" = the harness hook file exists under ``<project>/.harness/hooks/``.
Claude Code runs hooks with the project root as cwd, so ``Path.cwd()`` is the
right anchor — it matches how ``pre-compact-state.py`` already resolves
``.harness/``.
"""

from __future__ import annotations

from pathlib import Path


def harness_hook_present(js_basename: str, cwd: Path | str | None = None) -> bool:
    """Return True when the harness JS counterpart hook is wired in this project.

    Args:
        js_basename: The harness hook filename, e.g. ``"block-no-verify.js"``.
        cwd: Project root to resolve against. Defaults to the current working
            directory (how Claude Code invokes hooks).
    """
    root = Path(cwd) if cwd is not None else Path.cwd()
    return (root / ".harness" / "hooks" / js_basename).is_file()


def ruff_config_present(cwd: Path | str | None = None) -> bool:
    """Return True when a standalone ruff config file exists in this project.

    The harness ``format-check.js`` detector only runs ruff when it finds a
    ``.ruff.toml`` / ``ruff.toml`` file; it cannot see ruff config nested in
    ``pyproject.toml``. quality-gate.py therefore only cedes ruff to harness
    when such a standalone config exists (otherwise it is the *only* thing
    linting Python edits).
    """
    root = Path(cwd) if cwd is not None else Path.cwd()
    return (root / ".ruff.toml").is_file() or (root / "ruff.toml").is_file()
