import tempfile
import unittest
from pathlib import Path

from agent.core.skill_registry import SkillInfo, SkillRegistry


class TestBundledSkills(unittest.TestCase):
    def test_discover_returns_bundled_slash_skills(self):
        skills = SkillRegistry().discover()
        names = {s.name for s in skills}
        self.assertIn("oracle:generate", names)
        self.assertIn("oracle:init", names)
        self.assertIn("oracle:migrate", names)

    def test_discover_returns_bundled_harness_skills(self):
        skills = SkillRegistry().discover()
        names = {s.name for s in skills}
        self.assertIn("oracle-generate-test", names)

    def test_all_bundled_skills_have_paths(self):
        for skill in SkillRegistry().discover():
            self.assertIsInstance(skill.path, Path)
            self.assertTrue(skill.path.exists())

    def test_bundled_skills_have_source_bundled(self):
        skills = SkillRegistry().discover()
        for s in skills:
            self.assertIn(s.source, ("bundled", "local"))

    def test_result_is_sorted_by_name(self):
        skills = SkillRegistry().discover()
        names = [s.name for s in skills]
        self.assertEqual(names, sorted(names))


class TestLocalOverlaySkills(unittest.TestCase):
    def _make_git_root(self, tmp: str) -> Path:
        root = Path(tmp)
        (root / ".git").mkdir()
        return root

    def _make_skill(self, skills_root: Path, name: str, description: str = "") -> None:
        skill_dir = skills_root / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"
        )

    def test_local_skill_discovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            self._make_skill(root / ".oracle" / "skills", "my-custom-skill", "Custom")
            skills = SkillRegistry().discover(root)
            names = {s.name for s in skills}
            self.assertIn("my-custom-skill", names)

    def test_local_skill_has_source_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            self._make_skill(root / ".oracle" / "skills", "company-skill")
            skills = SkillRegistry().discover(root)
            local = [s for s in skills if s.name == "company-skill"]
            self.assertEqual(len(local), 1)
            self.assertEqual(local[0].source, "local")

    def test_local_skill_overrides_bundled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            self._make_skill(
                root / ".oracle" / "skills", "oracle:generate", "Company override"
            )
            skills = SkillRegistry().discover(root)
            matches = [s for s in skills if s.name == "oracle:generate"]
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0].source, "local")
            self.assertEqual(matches[0].description, "Company override")

    def test_local_skill_discovered_from_subdirectory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            self._make_skill(root / ".oracle" / "skills", "team-skill")
            subdir = root / "src" / "components"
            subdir.mkdir(parents=True)
            skills = SkillRegistry().discover(subdir)
            names = {s.name for s in skills}
            self.assertIn("team-skill", names)

    def test_no_oracle_dir_returns_only_bundled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            skills = SkillRegistry().discover(root)
            self.assertTrue(all(s.source == "bundled" for s in skills))

    def test_multiple_local_skills(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._make_git_root(tmp)
            overlay = root / ".oracle" / "skills"
            self._make_skill(overlay, "skill-a")
            self._make_skill(overlay, "skill-b")
            skills = SkillRegistry().discover(root)
            names = {s.name for s in skills}
            self.assertIn("skill-a", names)
            self.assertIn("skill-b", names)


class TestAncestorWalk(unittest.TestCase):
    def test_stops_at_git_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            subdir = root / "a" / "b" / "c"
            subdir.mkdir(parents=True)
            ancestors = SkillRegistry()._ancestors_to_git_root(subdir)
            self.assertIn(root, ancestors)
            self.assertEqual(ancestors[-1], root)

    def test_includes_all_intermediate_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            subdir = root / "x" / "y"
            subdir.mkdir(parents=True)
            ancestors = SkillRegistry()._ancestors_to_git_root(subdir)
            self.assertIn(root / "x", ancestors)


class TestFrontmatterParser(unittest.TestCase):
    def test_extracts_name(self):
        text = "---\nname: my-skill\ndescription: A skill\n---\n"
        result = SkillRegistry._frontmatter(text, "name")
        self.assertEqual(result, "my-skill")

    def test_extracts_description(self):
        text = "---\nname: x\ndescription: Does things\n---\n"
        result = SkillRegistry._frontmatter(text, "description")
        self.assertEqual(result, "Does things")

    def test_returns_none_without_frontmatter(self):
        text = "# No frontmatter here\n"
        self.assertIsNone(SkillRegistry._frontmatter(text, "name"))

    def test_returns_none_for_missing_field(self):
        text = "---\nname: x\n---\n"
        self.assertIsNone(SkillRegistry._frontmatter(text, "description"))


if __name__ == "__main__":
    unittest.main()
