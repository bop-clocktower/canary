"""Expose framework run-commands from the registry (#357).

The registry already carries per-framework `execution_command` + `ci_flags`;
these were invisible to CLI/MCP consumers. This covers the additive exposure:
a registry helper, `recommend --json` enrichment, and a `frameworks` dump.
"""

from __future__ import annotations

import json
import unittest

from typer.testing import CliRunner

from agent.cli import app
from agent.core.framework_registry import FrameworkRegistry


class TestRegistryExecutionInfo(unittest.TestCase):
    def test_execution_info_returns_command_and_flags(self):
        info = FrameworkRegistry().execution_info("playwright")
        self.assertIsNotNone(info)
        self.assertIn("{file}", info["execution_command"])
        self.assertIsInstance(info["ci_flags"], list)

    def test_execution_info_unknown_framework_is_none(self):
        self.assertIsNone(FrameworkRegistry().execution_info("nope-not-real"))

    def test_summaries_carry_the_run_command_fields(self):
        summaries = FrameworkRegistry().summaries()
        self.assertTrue(summaries)
        for s in summaries:
            self.assertIn("name", s)
            self.assertIn("execution_command", s)
            self.assertIn("ci_flags", s)
            self.assertIn("file_extensions", s)
            self.assertIn("status", s)
        names = {s["name"] for s in summaries}
        self.assertIn("playwright", names)


class TestRecommendJsonExposesRunCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_recommend_json_includes_execution_command_and_ci_flags(self):
        result = self.runner.invoke(
            app, ["recommend", "write a playwright e2e test for the login page", "--json"]
        )
        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        # Existing fields still present (backward compatible).
        self.assertIn("framework", payload)
        self.assertIn("reasoning", payload)
        # New fields.
        self.assertIn("execution_command", payload)
        self.assertIn("ci_flags", payload)
        if payload["framework"]:
            self.assertIn("{file}", payload["execution_command"])


class TestFrameworksCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_frameworks_json_dumps_registry_entries(self):
        result = self.runner.invoke(app, ["frameworks", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertIn("frameworks", payload)
        entries = payload["frameworks"]
        self.assertTrue(entries)
        pw = next((e for e in entries if e["name"] == "playwright"), None)
        self.assertIsNotNone(pw)
        self.assertIn("{file}", pw["execution_command"])

    def test_frameworks_human_lists_names_and_commands(self):
        result = self.runner.invoke(app, ["frameworks"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("playwright", result.output)


if __name__ == "__main__":
    unittest.main()
