"""Consistency contract for canary's MCP server identity (issue #309).

Canary's MCP server was named inconsistently across config/manifest files, and
the ``prefer-first-party-mcp.js`` trust list whitelisted a prefix that no real
canary tool ever uses. These tests lock the canonical name — ``canary-mcp`` —
across ``plugin.json``, ``.mcp.json``, ``marketplace.json``, ``pyproject.toml``,
and the harness first-party-MCP trust list, so the identity can't silently drift
again.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parents[2]
CANONICAL = "canary-mcp"


class TestMcpServerIdentity(unittest.TestCase):
    def test_plugin_json_declares_canonical_server(self):
        data = json.loads((REPO_ROOT / ".claude-plugin" / "plugin.json").read_text())
        servers = data["mcpServers"]
        self.assertIn(CANONICAL, servers)
        self.assertEqual(servers[CANONICAL]["command"], CANONICAL)

    def test_plugin_json_carries_canonical_name_comment(self):
        # A "//" note documents the canonical identity for the docs agent.
        data = json.loads((REPO_ROOT / ".claude-plugin" / "plugin.json").read_text())
        self.assertIn("//", data)
        self.assertIn(CANONICAL, data["//"])

    def test_mcp_json_lists_canonical_server(self):
        data = json.loads((REPO_ROOT / ".mcp.json").read_text())
        self.assertIn(CANONICAL, data["mcpServers"])
        self.assertEqual(data["mcpServers"][CANONICAL]["command"], CANONICAL)

    def test_marketplace_description_names_canonical_server(self):
        data = json.loads((REPO_ROOT / ".claude-plugin" / "marketplace.json").read_text())
        canary = next(p for p in data["plugins"] if p["name"] == "canary")
        self.assertIn(CANONICAL, canary["description"])
        # The stale "the harness MCP server" phrasing must be gone.
        self.assertNotIn("harness MCP server", canary["description"])

    def test_pyproject_defines_canary_mcp_console_script(self):
        text = (REPO_ROOT / "pyproject.toml").read_text()
        self.assertRegex(text, r"(?m)^canary-mcp\s*=\s*\"agent\.mcp_server:main\"")


class TestPreferFirstPartyMcpTrustList(unittest.TestCase):
    HOOK = REPO_ROOT / ".harness" / "hooks" / "prefer-first-party-mcp.js"

    def _run_hook(self, tool_name: str) -> subprocess.CompletedProcess:
        node = shutil.which("node")
        if node is None:  # pragma: no cover - node always present in CI
            self.skipTest("node not available")
        return subprocess.run(
            [node, str(self.HOOK)],
            input=json.dumps({"tool_name": tool_name}),
            capture_output=True,
            text=True,
        )

    def test_source_trusts_canary_mcp_prefix(self):
        src = self.HOOK.read_text()
        self.assertIn("mcp__canary-mcp__", src)

    def test_canary_mcp_call_is_not_nagged(self):
        r = self._run_hook("mcp__canary-mcp__write_test_file")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_harness_canary_call_is_not_nagged(self):
        # Canary tools served via harness (mcp__harness__canary_*) are trusted.
        r = self._run_hook("mcp__harness__canary_probe")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_third_party_call_is_nagged(self):
        r = self._run_hook("mcp__slack__send_message")
        self.assertEqual(r.returncode, 0)
        self.assertIn("additionalContext", r.stdout)


if __name__ == "__main__":
    unittest.main()
