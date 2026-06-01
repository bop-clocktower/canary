"""Tests for global ~/.canary/skills/ skill discovery."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.skill_registry import SkillRegistry


def _write_skill(base: Path, name: str, source_label: str = "global", deploy_to: list[str] | None = None) -> Path:
    skill_dir = base / ".canary" / "skills" / name
    skill_dir.mkdir(parents=True)
    dt_line = f"deploy_to: [{', '.join(deploy_to)}]\n" if deploy_to else ""
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\n{dt_line}---\n\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


class TestGlobalSkillDiscovery(unittest.TestCase):
    def _discover(self, home: Path, cwd: Path) -> list:
        with patch("agent.core.skill_registry.Path.home", return_value=home):
            return SkillRegistry().discover(cwd)

    def test_global_skill_discovered_outside_any_repo(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "my-global-skill")
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        names = [s.name for s in skills]
        self.assertIn("my-global-skill", names)

    def test_global_skill_source_is_global(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "my-global-skill")
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        skill = next(s for s in skills if s.name == "my-global-skill")
        self.assertEqual(skill.source, "global")

    def test_local_skill_overrides_global_same_name(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "shared-skill")
            # Also write as local (higher priority)
            local_dir = Path(cwd_tmp) / ".canary" / "skills" / "shared-skill"
            local_dir.mkdir(parents=True)
            (local_dir / "SKILL.md").write_text(
                "---\nname: shared-skill\n---\n\n# Local version\n", encoding="utf-8"
            )
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        skill = next(s for s in skills if s.name == "shared-skill")
        self.assertEqual(skill.source, "local")

    def test_no_global_dir_returns_no_global_skills(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            # Don't create ~/.canary/skills/
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        self.assertFalse(any(s.source == "global" for s in skills))

    def test_multiple_global_skills_all_discovered(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "skill-alpha")
            _write_skill(Path(home_tmp), "skill-beta")
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        global_names = {s.name for s in skills if s.source == "global"}
        self.assertIn("skill-alpha", global_names)
        self.assertIn("skill-beta", global_names)

    def test_global_skill_with_deploy_to_parsed(self):
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "login-helper", deploy_to=["e2e_ui", "api"])
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        skill = next(s for s in skills if s.name == "login-helper")
        self.assertEqual(skill.deploy_to, ["e2e_ui", "api"])

    def test_global_skill_wins_over_bundled(self):
        """Global skills have higher priority than bundled ones with the same name."""
        with tempfile.TemporaryDirectory() as home_tmp, tempfile.TemporaryDirectory() as cwd_tmp:
            _write_skill(Path(home_tmp), "verify")  # 'verify' exists as bundled
            skills = self._discover(Path(home_tmp), Path(cwd_tmp))
        verify = next((s for s in skills if s.name == "verify"), None)
        if verify:  # only assert if bundled 'verify' exists in this install
            self.assertEqual(verify.source, "global")

    def test_global_skill_available_from_any_cwd(self):
        with tempfile.TemporaryDirectory() as home_tmp:
            _write_skill(Path(home_tmp), "my-global-skill")
            # Test from two different unrelated directories
            with tempfile.TemporaryDirectory() as cwd1, tempfile.TemporaryDirectory() as cwd2:
                skills1 = self._discover(Path(home_tmp), Path(cwd1))
                skills2 = self._discover(Path(home_tmp), Path(cwd2))
        self.assertIn("my-global-skill", [s.name for s in skills1])
        self.assertIn("my-global-skill", [s.name for s in skills2])


if __name__ == "__main__":
    unittest.main()
