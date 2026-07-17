"""CLI-level tests for `canary migrate` overlay resolution (--from / --overlay).

Covers the Phase 3 precedence ladder end-to-end through the Typer CLI: --from by
name/path, the single-overlay default, the multi-overlay ambiguity error, the
--overlay deprecation notice, and --from winning over --overlay. The migrate
core itself is covered by test_migrator.py; here we assert the resolution
messages and exit codes, and that pre-existing behavior is unchanged.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from agent.cli import app


def _fake_harness_project(root: Path) -> None:
    """Minimal project that migrate.detect() accepts as a harness project."""
    (root / "harness.config.json").write_text('{"framework": "vitest"}', encoding="utf-8")
    (root / ".harness").mkdir()


def _add_overlay(home: Path, name: str) -> Path:
    """A tracked-overlay clone with one deploy_to:all skill so deployment is a no-op-safe."""
    skills = home / ".canary" / "overlays" / name / ".canary" / "skills" / "demo-skill"
    skills.mkdir(parents=True)
    (skills / "SKILL.md").write_text(
        "---\nname: demo-skill\ndeploy_to: [all]\n---\n\n# demo-skill\n", encoding="utf-8"
    )
    return home / ".canary" / "overlays" / name


class TestMigrateOverlayResolution(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def _run(self, project: Path, home: Path, *args: str):
        # Patch Path.home so overlay-name resolution reads the temp home.
        with patch.object(Path, "home", return_value=home):
            return self.runner.invoke(app, ["migrate", "--path", str(project), *args])

    def test_from_name_resolves_and_migrates(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            _add_overlay(home, "example-org-example-overlay")
            result = self._run(project, home, "--from", "example-org-example-overlay")
            self.assertEqual(result.exit_code, 0, result.output)

    def test_from_path_used_directly(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            # A path-form --from (has a separator); not registered as a name.
            overlay = base / "sibling-overlay"
            (overlay / ".canary" / "skills").mkdir(parents=True)
            result = self._run(project, home, "--from", str(overlay))
            self.assertEqual(result.exit_code, 0, result.output)

    def test_single_tracked_overlay_is_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            _add_overlay(home, "solo-overlay")
            result = self._run(project, home)  # no --from, no --overlay
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertIn("solo-overlay", result.output)
            self.assertIn("only one registered", result.output)

    def test_no_overlays_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            (home / ".canary").mkdir(parents=True)  # home exists, no overlays
            result = self._run(project, home)
            self.assertEqual(result.exit_code, 0, result.output)
            # No default-overlay chatter when nothing is tracked.
            self.assertNotIn("tracked overlay", result.output.lower())

    def test_multiple_overlays_ambiguous_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            _add_overlay(home, "alpha-overlay")
            _add_overlay(home, "beta-overlay")
            result = self._run(project, home)  # no --from → ambiguous
            self.assertNotEqual(result.exit_code, 0)
            self.assertIn("alpha-overlay", result.output)
            self.assertIn("beta-overlay", result.output)
            self.assertIn("--from", result.output)

    def test_overlay_flag_prints_deprecation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            overlay = _add_overlay(home, "legacy-overlay")
            result = self._run(project, home, "--overlay", str(overlay))
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertIn("deprecated", result.output.lower())

    def test_from_beats_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            _add_overlay(home, "chosen-overlay")
            other = _add_overlay(home, "ignored-overlay")
            result = self._run(
                project, home, "--from", "chosen-overlay", "--overlay", str(other)
            )
            self.assertEqual(result.exit_code, 0, result.output)
            self.assertIn("ignoring --overlay", result.output)

    def test_unresolvable_from_exits_with_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            project, home = base / "proj", base / "home"
            project.mkdir()
            _fake_harness_project(project)
            _add_overlay(home, "real-overlay")
            result = self._run(project, home, "--from", "typo-overlay")
            self.assertNotEqual(result.exit_code, 0)
            self.assertIn("typo-overlay", result.output)
            self.assertIn("real-overlay", result.output)


if __name__ == "__main__":
    unittest.main()
