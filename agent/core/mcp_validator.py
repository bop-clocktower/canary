# agent/core/mcp_validator.py

"""
MCP server identifier validation for company knowledge.

Resolves which MCP server identifiers are registered in the current Claude Code
session by scanning:

  1. <root>/.mcp.json and ~/.mcp.json  — plain server keys (e.g. "harness")
  2. Installed Claude Code plugins      — plugin-prefixed keys
     Format: plugin_{plugin_slug}_{server_key}
     e.g. atlassian plugin, "atlassian" server → "plugin_atlassian_atlassian"

No network calls are made; this is a local config scan only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class MCPValidationResult:
    server_id: str
    status: str           # "registered" | "not_found" | "plugin_disabled"
    source: str = ""      # where it was found (for display)
    note: str = ""


def validate_mcp_servers(
    server_ids: list[str],
    root: Optional[Path] = None,
) -> list[MCPValidationResult]:
    """Check each server_id against locally registered MCP sources.

    Returns one MCPValidationResult per server_id.
    """
    registry = _build_registry(root or Path.cwd())
    results: list[MCPValidationResult] = []
    for sid in server_ids:
        if sid in registry:
            source, note, status = registry[sid]
            results.append(MCPValidationResult(sid, status, source, note))
        else:
            results.append(MCPValidationResult(sid, "not_found"))
    return results


# ── registry builder ──────────────────────────────────────────────────────────


def _build_registry(root: Path) -> dict[str, tuple[str, str, str]]:
    """Return {server_id: (source_label, note, status)} for all locally known MCP servers."""
    registry: dict[str, tuple[str, str, str]] = {}

    # 1. Project-local .mcp.json
    _ingest_mcp_json(root / ".mcp.json", "project .mcp.json", registry)

    # 2. Home-dir .mcp.json
    _ingest_mcp_json(Path.home() / ".mcp.json", "~/.mcp.json", registry)

    # 3. Installed Claude Code plugins
    _ingest_plugins(registry)

    return registry


def _ingest_mcp_json(path: Path, label: str, registry: dict) -> None:
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    for key in data.get("mcpServers", {}).keys():
        if isinstance(key, str) and key not in registry:
            registry[key] = (label, "", "registered")


def _ingest_plugins(registry: dict) -> None:
    """Scan installed Claude Code plugins and derive their MCP server identifiers."""
    plugins_cache = Path.home() / ".claude" / "plugins" / "cache"
    if not plugins_cache.is_dir():
        return

    enabled = _load_enabled_plugins()

    for marketplace_dir in plugins_cache.iterdir():
        if not marketplace_dir.is_dir():
            continue
        marketplace_slug = marketplace_dir.name  # e.g. "claude-plugins-official"

        for plugin_dir in marketplace_dir.iterdir():
            if not plugin_dir.is_dir():
                continue
            plugin_slug = plugin_dir.name  # e.g. "atlassian"
            plugin_key = f"{plugin_slug}@{marketplace_slug}"
            is_enabled = enabled.get(plugin_key, False)

            # Each plugin may have multiple version dirs; use the most recent.
            version_dirs = sorted(
                [d for d in plugin_dir.iterdir() if d.is_dir()],
                key=lambda d: d.stat().st_mtime,
                reverse=True,
            )
            for version_dir in version_dirs:
                mcp_json = version_dir / ".mcp.json"
                if not mcp_json.exists():
                    continue
                try:
                    data = json.loads(mcp_json.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue

                for server_key in data.get("mcpServers", {}).keys():
                    if not isinstance(server_key, str):
                        continue
                    # Claude Code tool namespace: plugin_{plugin_slug}_{server_key}
                    derived_id = f"plugin_{plugin_slug}_{server_key}"
                    if derived_id in registry:
                        continue
                    status = "registered" if is_enabled else "plugin_disabled"
                    note = "" if is_enabled else f"plugin {plugin_key!r} is installed but not enabled"
                    source = f"plugin {plugin_key!r}"
                    registry[derived_id] = (source, note, status)
                break  # only inspect the most recent version dir that has .mcp.json


def _load_enabled_plugins() -> dict[str, bool]:
    """Load enabledPlugins from ~/.claude/settings.json."""
    settings_path = Path.home() / ".claude" / "settings.json"
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
        enabled = data.get("enabledPlugins", {})
        if isinstance(enabled, dict):
            return enabled
    except (OSError, json.JSONDecodeError):
        pass
    return {}
