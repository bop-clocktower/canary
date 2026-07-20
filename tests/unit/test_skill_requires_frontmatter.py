"""Skill `requires:` frontmatter parsing + contract-adoption guard (#336).

`requires` declares a skill's runtime tool dependencies (e.g. python3, node),
which `canary doctor` verifies for installed skills. Two guarantees here:

1. The Python loader parses `requires` into SkillInfo (flow list or scalar).
2. **No half-adopted contract:** every *executable* bundled skill (one with a
   `cli:`/`entry:` runtime) must declare a non-empty `requires`, so doctor's
   "requirements satisfied" is never a false comfort born of missing
   declarations.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.skill_registry import SkillRegistry


class TestRequiresParsing(unittest.TestCase):
    def test_flow_list_is_parsed(self):
        fm = SkillRegistry._parse_frontmatter(
            "---\nname: x\nrequires: [python3>=3.10, node>=20]\n---\n"
        )
        self.assertEqual(
            SkillRegistry._parse_str_list(fm, "requires"),
            ["python3>=3.10", "node>=20"],
        )

    def test_scalar_is_normalized_to_list(self):
        fm = SkillRegistry._parse_frontmatter("---\nname: x\nrequires: python3\n---\n")
        self.assertEqual(SkillRegistry._parse_str_list(fm, "requires"), ["python3"])

    def test_absent_is_empty_list(self):
        fm = SkillRegistry._parse_frontmatter("---\nname: x\n---\n")
        self.assertEqual(SkillRegistry._parse_str_list(fm, "requires"), [])

    def test_skillinfo_exposes_requires(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            d = home / ".canary" / "skills" / "runner"
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(
                "---\nname: runner\ncli: scripts/cli.py\nrequires: [python3>=3.10]\n---\n",
                encoding="utf-8",
            )
            with patch("agent.core.skill_registry.Path.home", return_value=home):
                skill = SkillRegistry().find("runner", home)
            self.assertEqual(skill.requires, ["python3>=3.10"])


class TestExecutableSkillsDeclareRequires(unittest.TestCase):
    """Contract-adoption guard: no executable bundled skill ships without a
    declared runtime requirement (#336). A new cli/entry skill added without
    `requires:` fails here, keeping doctor's verification honest."""

    def test_every_executable_bundled_skill_declares_requires(self):
        # Isolate from the developer's real ~/.canary so only bundled skills
        # are inspected (mirrors TestBundledSkills' isolation, #349).
        with tempfile.TemporaryDirectory() as home:
            with patch("agent.core.skill_registry.Path.home", return_value=Path(home)):
                skills = SkillRegistry().discover()
            executable = [s for s in skills if s.is_executable]
            self.assertTrue(executable, "expected some executable bundled skills")
            missing = [s.name for s in executable if not s.requires]
            self.assertEqual(
                missing,
                [],
                f"executable skills missing a `requires:` declaration: {missing}",
            )

    def test_python_cli_skills_require_python3(self):
        with tempfile.TemporaryDirectory() as home:
            with patch("agent.core.skill_registry.Path.home", return_value=Path(home)):
                skills = {s.name: s for s in SkillRegistry().discover()}
            for name in ("canary-fail-fast", "canary-instrument", "canary-test-reporter"):
                self.assertIn(name, skills)
                joined = " ".join(skills[name].requires)
                self.assertIn("python3", joined, f"{name} should require python3")


if __name__ == "__main__":
    unittest.main()
