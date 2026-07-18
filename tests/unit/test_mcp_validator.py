"""Tests for mcp_validator — registry building and validation results."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.mcp_validator import (
    MCPValidationResult,
    validate_mcp_servers,
    collect_config_warnings,
    _build_registry,
)


def _write_mcp_json(directory: Path, servers: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / ".mcp.json").write_text(
        json.dumps({"mcpServers": {k: {"command": "dummy"} for k in servers}}),
        encoding="utf-8",
    )


class TestValidateMcpServers(unittest.TestCase):
    def test_registered_server_from_project_mcp_json(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            root = Path(tmp)
            _write_mcp_json(root, {"harness": {}})
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                results = validate_mcp_servers(["harness"], root)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "registered")
        self.assertIn("project .mcp.json", results[0].source)

    def test_not_found_server(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                results = validate_mcp_servers(["nonexistent_server"], Path(tmp))
        self.assertEqual(results[0].status, "not_found")

    def test_empty_server_list_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                results = validate_mcp_servers([], Path(tmp))
        self.assertEqual(results, [])

    def test_multiple_servers_mixed_results(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            root = Path(tmp)
            _write_mcp_json(root, {"harness": {}})
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                results = validate_mcp_servers(["harness", "missing_server"], root)
        statuses = {r.server_id: r.status for r in results}
        self.assertEqual(statuses["harness"], "registered")
        self.assertEqual(statuses["missing_server"], "not_found")

    def test_home_mcp_json_server_registered(self):
        with tempfile.TemporaryDirectory() as project_tmp:
            with tempfile.TemporaryDirectory() as home_tmp:
                _write_mcp_json(Path(home_tmp), {"global_server": {}})
                with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                    results = validate_mcp_servers(["global_server"], Path(project_tmp))
        self.assertEqual(results[0].status, "registered")
        self.assertIn("~/.mcp.json", results[0].source)

    def test_project_mcp_json_takes_precedence_over_home(self):
        with tempfile.TemporaryDirectory() as project_tmp:
            with tempfile.TemporaryDirectory() as home_tmp:
                _write_mcp_json(Path(project_tmp), {"shared": {}})
                _write_mcp_json(Path(home_tmp), {"shared": {}})
                with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                    results = validate_mcp_servers(["shared"], Path(project_tmp))
        # registered from project (first wins)
        self.assertEqual(results[0].status, "registered")
        self.assertIn("project .mcp.json", results[0].source)


class TestPluginRegistry(unittest.TestCase):
    def _make_plugin_cache(
        self,
        home: Path,
        plugin_slug: str,
        server_keys: list[str],
        enabled: bool = True,
        marketplace: str = "claude-plugins-official",
    ) -> None:
        plugin_dir = home / ".claude" / "plugins" / "cache" / marketplace / plugin_slug / "v1.0.0"
        plugin_dir.mkdir(parents=True)
        (plugin_dir / ".mcp.json").write_text(
            json.dumps({"mcpServers": {k: {"command": "dummy"} for k in server_keys}}),
            encoding="utf-8",
        )
        settings = {"enabledPlugins": {f"{plugin_slug}@{marketplace}": enabled}}
        settings_path = home / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings), encoding="utf-8")

    def test_enabled_plugin_server_registered(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._make_plugin_cache(home, "atlassian", ["atlassian"], enabled=True)
            with patch("agent.core.mcp_validator.Path.home", return_value=home):
                results = validate_mcp_servers(["plugin_atlassian_atlassian"], Path(tmp))
        self.assertEqual(results[0].status, "registered")
        self.assertIn("atlassian", results[0].source)

    def test_disabled_plugin_server_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._make_plugin_cache(home, "atlassian", ["atlassian"], enabled=False)
            with patch("agent.core.mcp_validator.Path.home", return_value=home):
                results = validate_mcp_servers(["plugin_atlassian_atlassian"], Path(tmp))
        self.assertEqual(results[0].status, "plugin_disabled")
        self.assertIn("not enabled", results[0].note)

    def test_plugin_with_multiple_server_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._make_plugin_cache(home, "myplugin", ["alpha", "beta"], enabled=True)
            with patch("agent.core.mcp_validator.Path.home", return_value=home):
                registry = _build_registry(Path(tmp))
        self.assertIn("plugin_myplugin_alpha", registry)
        self.assertIn("plugin_myplugin_beta", registry)

    def test_missing_plugins_cache_is_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            # No .claude/plugins/cache directory created
            with patch("agent.core.mcp_validator.Path.home", return_value=home):
                results = validate_mcp_servers(["plugin_something_server"], Path(tmp))
        self.assertEqual(results[0].status, "not_found")

    def test_malformed_plugin_mcp_json_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            plugin_dir = home / ".claude" / "plugins" / "cache" / "official" / "bad" / "v1"
            plugin_dir.mkdir(parents=True)
            (plugin_dir / ".mcp.json").write_text("{broken json", encoding="utf-8")
            with patch("agent.core.mcp_validator.Path.home", return_value=home):
                results = validate_mcp_servers(["plugin_bad_server"], Path(tmp))
        self.assertEqual(results[0].status, "not_found")


class TestConfigWarnings(unittest.TestCase):
    """Fix #2: a malformed (but present) .mcp.json must warn, not silently
    behave as if there were no config at all. See
    agent/core/config_validation.py — the same helper migrator.py uses."""

    def test_malformed_project_mcp_json_yields_warning(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text("{not valid json", encoding="utf-8")
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                warnings = collect_config_warnings(root)
        self.assertTrue(any(".mcp.json" in w for w in warnings), warnings)

    def test_malformed_home_mcp_json_yields_warning(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            (Path(home_tmp) / ".mcp.json").write_text("{broken", encoding="utf-8")
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                warnings = collect_config_warnings(Path(tmp))
        self.assertTrue(any(".mcp.json" in w for w in warnings), warnings)

    def test_well_formed_mcp_json_has_no_warnings(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            root = Path(tmp)
            _write_mcp_json(root, {"harness": {}})
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                warnings = collect_config_warnings(root)
        self.assertEqual(warnings, [])

    def test_absent_mcp_json_has_no_warnings(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                warnings = collect_config_warnings(Path(tmp))
        self.assertEqual(warnings, [])

    def test_malformed_mcp_json_does_not_crash_validate_mcp_servers(self):
        """validate_mcp_servers must keep working (degrade to not_found)
        even when .mcp.json is malformed — warnings are opt-in via the
        separate collect_config_warnings() pass, never a hard failure."""
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as home_tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text("{not valid json", encoding="utf-8")
            with patch("agent.core.mcp_validator.Path.home", return_value=Path(home_tmp)):
                results = validate_mcp_servers(["harness"], root)
        self.assertEqual(results[0].status, "not_found")


class TestMCPValidationResult(unittest.TestCase):
    def test_dataclass_fields(self):
        r = MCPValidationResult("harness", "registered", "project .mcp.json", "")
        self.assertEqual(r.server_id, "harness")
        self.assertEqual(r.status, "registered")

    def test_defaults(self):
        r = MCPValidationResult("harness", "not_found")
        self.assertEqual(r.source, "")
        self.assertEqual(r.note, "")


if __name__ == "__main__":
    unittest.main()
