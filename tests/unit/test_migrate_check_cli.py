"""CLI-level tests for `canary migrate --check` (issue #334).

The freshness gate exposes drift detection through the Typer CLI: exit 0 when the
consuming repo is in sync with the overlay, exit 1 when the overlay carries newer
deployable skills (drift), and exit 2 when a deployed skill has local edits (the
one-way-ownership safety refusal). `--json` emits a machine-readable summary for
the scheduled-CI recipe.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from agent.cli import app
from agent.core.migrator import HarnessMigrator


def _fake_harness_project(root: Path) -> None:
    (root / "harness.config.json").write_text('{"language": "python"}', encoding="utf-8")
    (root / ".harness").mkdir()


def _overlay(base: Path, dir_name: str = "demo", body: str = "# demo v1") -> Path:
    overlay = base / "overlay"
    skill_dir = overlay / ".canary" / "skills" / dir_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {dir_name}\ndeploy_to: [all]\n---\n\n{body}\n", encoding="utf-8"
    )
    return overlay


class TestMigrateCheckCli(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def _run(self, project: Path, home: Path, *args: str):
        with patch.object(Path, "home", return_value=home):
            return self.runner.invoke(app, ["migrate", "--path", str(project), *args])

    def test_in_sync_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            home.mkdir()
            _fake_harness_project(project)
            overlay = _overlay(base)
            HarnessMigrator().migrate(project, dry_run=False, overlay_path=overlay)
            result = self._run(project, home, "--from", str(overlay), "--check")
            self.assertEqual(result.exit_code, 0, result.output)

    def test_drift_exits_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            home.mkdir()
            _fake_harness_project(project)
            overlay = _overlay(base)  # never deployed → missing → drift
            result = self._run(project, home, "--from", str(overlay), "--check")
            self.assertEqual(result.exit_code, 1, result.output)
            self.assertIn("demo", result.output)

    def test_local_edit_exits_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            home.mkdir()
            _fake_harness_project(project)
            overlay = _overlay(base)
            HarnessMigrator().migrate(project, dry_run=False, overlay_path=overlay)
            (project / ".canary" / "skills" / "demo" / "SKILL.md").write_text(
                "---\nname: demo\ndeploy_to: [all]\n---\n\n# demo — edited\n", encoding="utf-8"
            )
            result = self._run(project, home, "--from", str(overlay), "--check")
            self.assertEqual(result.exit_code, 2, result.output)
            self.assertIn("local", result.output.lower())

    def test_json_summary_is_machine_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            home.mkdir()
            _fake_harness_project(project)
            overlay = _overlay(base)
            result = self._run(project, home, "--from", str(overlay), "--check", "--json")
            self.assertEqual(result.exit_code, 1, result.output)
            # The JSON object is the last brace-delimited block in the output.
            payload = json.loads(result.output[result.output.index("{"): result.output.rindex("}") + 1])
            self.assertIn("has_drift", payload)
            self.assertTrue(payload["has_drift"])
            self.assertEqual(payload["skills"][0]["status"], "missing")


if __name__ == "__main__":
    unittest.main()
