"""CliRunner coverage for previously-untested `canary` subcommands.

Fix #4 of the CLI confidence/error-handling hardening (issue #299): the
`run`, `skills run`, `ticket-update`, and `workflow-discover` command
surfaces had little to no test coverage, in particular around their
error-swallowing / early-exit branches. These tests exercise the failure
paths (bad framework, missing skill, malformed result JSON, no project
keys) as well as the success path, so a regression in those branches is
caught.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from agent.cli import app


@contextlib.contextmanager
def _chdir_tmp():
    """Run inside a fresh temp directory (Typer's CliRunner, unlike Click's,
    has no isolated_filesystem helper)."""
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        try:
            yield Path(tmp)
        finally:
            os.chdir(prev)


class TestRunCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_run_reports_success_exit(self):
        with patch("agent.core.executor.CanaryTestExecutor") as MockExec:
            MockExec.return_value.execute.return_value = (0, "1 passed", "")
            result = self.runner.invoke(app, ["run", "some_test.py", "pytest"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("Success", result.output)

    def test_run_reports_failure_with_stderr(self):
        with patch("agent.core.executor.CanaryTestExecutor") as MockExec:
            MockExec.return_value.execute.return_value = (1, "", "boom traceback")
            result = self.runner.invoke(app, ["run", "some_test.py", "pytest"])
        # The command itself succeeds (it reports the failure, doesn't crash).
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("Failure", result.output)
        self.assertIn("boom traceback", result.output)


class TestSkillsRunCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_missing_skill_exits_1(self):
        with patch("agent.core.skill_registry.SkillRegistry") as MockReg:
            MockReg.return_value.find.return_value = None
            result = self.runner.invoke(app, ["skills", "run", "no-such-skill"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("no-such-skill", result.output)

    def test_skill_with_validation_error_exits_2(self):
        fake = types.SimpleNamespace(
            error="both cli and entry declared", is_executable=True,
            cli=None, entry=None, name="broken", dir=Path("."),
        )
        with patch("agent.core.skill_registry.SkillRegistry") as MockReg:
            MockReg.return_value.find.return_value = fake
            result = self.runner.invoke(app, ["skills", "run", "broken"])
        self.assertEqual(result.exit_code, 2)
        self.assertIn("both cli and entry", result.output)

    def test_markdown_only_skill_exits_2(self):
        fake = types.SimpleNamespace(
            error=None, is_executable=False,
            cli=None, entry=None, name="doc-skill", dir=Path("."),
        )
        with patch("agent.core.skill_registry.SkillRegistry") as MockReg:
            MockReg.return_value.find.return_value = fake
            result = self.runner.invoke(app, ["skills", "run", "doc-skill"])
        self.assertEqual(result.exit_code, 2)
        self.assertIn("markdown-only", result.output)


class TestTicketUpdateCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_malformed_result_json_exits_1(self):
        """The --result read is wrapped in a try/except that used to swallow
        errors; it must exit non-zero with a clear message instead."""
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "report.json"
            bad.write_text("{not valid json", encoding="utf-8")
            result = self.runner.invoke(app, ["ticket-update", "--result", str(bad)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Could not read result file", result.output)

    def test_missing_result_file_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.json"
            result = self.runner.invoke(app, ["ticket-update", "--result", str(missing)])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Could not read result file", result.output)


class TestWorkflowDiscoverCommand(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_no_project_and_no_company_json_exits_1(self):
        with _chdir_tmp():
            result = self.runner.invoke(app, ["workflow", "discover"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("No project keys found", result.output)

    def test_malformed_company_json_yields_no_keys_exits_1(self):
        """A malformed company.json is caught and leaves keys empty — the
        command must still exit cleanly (1) with guidance, not crash."""
        with _chdir_tmp() as tmp:
            canary = tmp / ".canary"
            canary.mkdir()
            (canary / "company.json").write_text("{broken", encoding="utf-8")
            result = self.runner.invoke(app, ["workflow", "discover"])
        self.assertEqual(result.exit_code, 1)
        self.assertIn("No project keys found", result.output)

    def test_discover_success_for_explicit_project(self):
        fake_mapping = types.SimpleNamespace(
            issue_types=["Bug", "Story"],
            semantic_roles={"in_progress": "In Progress"},
            role_annotations_confirmed=True,
            to_json=lambda: '{"key": "ACME"}',
        )
        with patch("agent.core.workflow_discovery.WorkflowDiscovery") as MockWd:
            MockWd.return_value.discover.return_value = fake_mapping
            result = self.runner.invoke(
                app, ["workflow", "discover", "--project", "ACME", "--dry-run"]
            )
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("ACME", result.output)


if __name__ == "__main__":
    unittest.main()
