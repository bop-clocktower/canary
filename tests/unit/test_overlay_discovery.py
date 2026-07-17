"""Tests for tracked-overlay skill discovery (~/.canary/overlays/*/.canary/skills/)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.skill_registry import SkillRegistry


def _write_overlay_skill(home: Path, overlay: str, name: str) -> Path:
    skill_dir = home / ".canary" / "overlays" / overlay / ".canary" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\n---\n\n# {name}\n", encoding="utf-8"
    )
    return skill_dir


def _write_global_skill(home: Path, name: str) -> Path:
    skill_dir = home / ".canary" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\n---\n\n# {name}\n", encoding="utf-8"
    )
    return skill_dir


def _write_local_skill(cwd: Path, name: str) -> Path:
    skill_dir = cwd / ".canary" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\n---\n\n# {name}\n", encoding="utf-8"
    )
    return skill_dir


class TestOverlayDiscovery(unittest.TestCase):
    def _discover(self, home: Path, cwd: Path) -> list:
        with patch("agent.core.skill_registry.Path.home", return_value=home):
            return SkillRegistry().discover(cwd)

    def test_overlay_skill_discovered(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            _write_overlay_skill(Path(home), "example-org-example-overlay", "ov-skill")
            names = [s.name for s in self._discover(Path(home), Path(cwd))]
        self.assertIn("ov-skill", names)

    def test_overlay_source_label(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            _write_overlay_skill(Path(home), "ov", "ov-skill")
            skills = self._discover(Path(home), Path(cwd))
        skill = next(s for s in skills if s.name == "ov-skill")
        self.assertEqual(skill.source, "overlay")

    def test_overlay_overrides_bundled(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            bundled = [s for s in self._discover(Path(home), Path(cwd)) if s.source == "bundled"]
            if not bundled:
                self.skipTest("no bundled skills available to shadow")
            name = bundled[0].name
            _write_overlay_skill(Path(home), "ov", name)
            skill = next(s for s in self._discover(Path(home), Path(cwd)) if s.name == name)
        self.assertEqual(skill.source, "overlay")

    def test_global_overrides_overlay(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            _write_overlay_skill(Path(home), "ov", "shared")
            _write_global_skill(Path(home), "shared")
            skill = next(s for s in self._discover(Path(home), Path(cwd)) if s.name == "shared")
        self.assertEqual(skill.source, "global")

    def test_local_overrides_overlay(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            _write_overlay_skill(Path(home), "ov", "shared")
            _write_local_skill(Path(cwd), "shared")
            skill = next(s for s in self._discover(Path(home), Path(cwd)) if s.name == "shared")
        self.assertEqual(skill.source, "local")

    def test_no_overlays_dir_yields_no_overlay_skills(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cwd:
            skills = self._discover(Path(home), Path(cwd))
        self.assertFalse(any(s.source == "overlay" for s in skills))


if __name__ == "__main__":
    unittest.main()
