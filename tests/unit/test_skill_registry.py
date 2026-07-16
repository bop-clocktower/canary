"""SkillRegistry discovery, frontmatter parsing, and cli:/entry: extension."""

import os
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch

from agent.core.skill_registry import (
    SkillRegistry,
    is_executable_skill_allowed,
    resolve_cli_path,
)


def _write_skill(
    skills_root: Path,
    name: str,
    *,
    description: str = "",
    cli: Optional[str] = None,
    entry: Optional[str] = None,
    body: str = "",
) -> Path:
    skill_dir = skills_root / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"name: {name}"]
    if description:
        lines.append(f"description: {description}")
    if cli:
        lines.append(f"cli: {cli}")
    if entry:
        lines.append(f"entry: {entry}")
    text = "---\n" + "\n".join(lines) + "\n---\n\n" + body
    (skill_dir / "SKILL.md").write_text(text)
    return skill_dir


def _make_git_root(tmp: str) -> Path:
    root = Path(tmp).resolve()
    (root / ".git").mkdir()
    return root


class TestBundledSkills(unittest.TestCase):

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

    def test_local_skill_discovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "my-custom-skill", description="Custom")
            skills = SkillRegistry().discover(root)
            names = {s.name for s in skills}
            self.assertIn("my-custom-skill", names)

    def test_local_skill_has_source_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "company-skill")
            local = [s for s in SkillRegistry().discover(root) if s.name == "company-skill"]
            self.assertEqual(len(local), 1)
            self.assertEqual(local[0].source, "local")

    def test_local_skill_overrides_bundled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(
                root / ".canary" / "skills",
                "canary-generate-test",
                description="Company override",
            )
            matches = [
                s for s in SkillRegistry().discover(root)
                if s.name == "canary-generate-test"
            ]
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0].source, "local")
            self.assertEqual(matches[0].description, "Company override")

    def test_local_skill_discovered_from_subdirectory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "team-skill")
            subdir = root / "src" / "components"
            subdir.mkdir(parents=True)
            names = {s.name for s in SkillRegistry().discover(subdir)}
            self.assertIn("team-skill", names)


class TestFrontmatterParser(unittest.TestCase):

    def test_extracts_name_and_description(self):
        text = "---\nname: my-skill\ndescription: Does things\n---\n"
        result = SkillRegistry._parse_frontmatter(text)
        self.assertEqual(result["name"], "my-skill")
        self.assertEqual(result["description"], "Does things")

    def test_extracts_cli_field(self):
        text = "---\nname: x\ncli: scripts/cli.py\n---\n"
        self.assertEqual(SkillRegistry._parse_frontmatter(text)["cli"], "scripts/cli.py")

    def test_extracts_entry_field(self):
        text = "---\nname: y\nentry: pkg.mod:main\n---\n"
        self.assertEqual(SkillRegistry._parse_frontmatter(text)["entry"], "pkg.mod:main")

    def test_returns_empty_without_frontmatter(self):
        self.assertEqual(SkillRegistry._parse_frontmatter("# no\n"), {})


class TestExecutableFields(unittest.TestCase):

    def test_cli_field_makes_skill_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "alpha", cli="scripts/cli.py")
            skill = SkillRegistry().find("alpha", root)
            self.assertEqual(skill.cli, "scripts/cli.py")
            self.assertIsNone(skill.entry)
            self.assertIsNone(skill.error)
            self.assertTrue(skill.is_executable)

    def test_entry_field_makes_skill_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "alpha", entry="pkg.mod:main")
            skill = SkillRegistry().find("alpha", root)
            self.assertEqual(skill.entry, "pkg.mod:main")
            self.assertTrue(skill.is_executable)

    def test_both_cli_and_entry_is_validation_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(
                root / ".canary" / "skills", "alpha",
                cli="scripts/cli.py", entry="pkg:main",
            )
            skill = SkillRegistry().find("alpha", root)
            self.assertIsNotNone(skill.error)
            self.assertIn("mutually exclusive", skill.error)
            self.assertFalse(skill.is_executable)

    def test_markdown_only_is_not_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(root / ".canary" / "skills", "alpha", description="prose only")
            skill = SkillRegistry().find("alpha", root)
            self.assertFalse(skill.is_executable)


class TestResolveCliPath(unittest.TestCase):

    def test_resolves_inside_skill_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            skill_dir = _write_skill(
                root / ".canary" / "skills", "alpha", cli="scripts/cli.py",
            )
            (skill_dir / "scripts").mkdir()
            (skill_dir / "scripts" / "cli.py").write_text("#!/usr/bin/env python3\n")
            skill = SkillRegistry().find("alpha", root)
            target = resolve_cli_path(skill)
            self.assertEqual(target.name, "cli.py")
            self.assertTrue(target.is_absolute())

    def test_rejects_path_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(
                root / ".canary" / "skills", "alpha", cli="../../../etc/passwd",
            )
            skill = SkillRegistry().find("alpha", root)
            with self.assertRaises(ValueError) as ctx:
                resolve_cli_path(skill)
            self.assertIn("escapes", str(ctx.exception))

    def test_rejects_missing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(
                root / ".canary" / "skills", "alpha", cli="scripts/missing.py",
            )
            skill = SkillRegistry().find("alpha", root)
            with self.assertRaises(ValueError) as ctx:
                resolve_cli_path(skill)
            self.assertIn("does not exist", str(ctx.exception))

    def test_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            skill_dir = _write_skill(
                root / ".canary" / "skills", "alpha", cli="scripts/cli.py",
            )
            outside = root / "outside.py"
            outside.write_text("#!/usr/bin/env python3\n")
            (skill_dir / "scripts").mkdir()
            try:
                (skill_dir / "scripts" / "cli.py").symlink_to(outside)
            except OSError:
                self.skipTest("symlink creation not supported")
            skill = SkillRegistry().find("alpha", root)
            with self.assertRaises(ValueError) as ctx:
                resolve_cli_path(skill)
            self.assertIn("escapes", str(ctx.exception))

    def test_rejects_skill_without_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _make_git_root(tmp)
            _write_skill(
                root / ".canary" / "skills", "alpha", description="prose only",
            )
            skill = SkillRegistry().find("alpha", root)
            with self.assertRaises(ValueError) as ctx:
                resolve_cli_path(skill)
            self.assertIn("no cli:", str(ctx.exception))


class TestIsExecutableSkillAllowed(unittest.TestCase):

    def test_interactive_tty_no_ci_allows(self):
        with patch.dict(os.environ, {"CI": ""}), \
             patch("sys.stdin.isatty", return_value=True):
            self.assertTrue(is_executable_skill_allowed(allow_flag=False))

    def test_ci_true_blocks(self):
        with patch.dict(os.environ, {"CI": "true"}), \
             patch("sys.stdin.isatty", return_value=True):
            self.assertFalse(is_executable_skill_allowed(allow_flag=False))

    def test_ci_with_flag_allows(self):
        with patch.dict(os.environ, {"CI": "true"}), \
             patch("sys.stdin.isatty", return_value=True):
            self.assertTrue(is_executable_skill_allowed(allow_flag=True))

    def test_non_tty_blocks(self):
        with patch.dict(os.environ, {"CI": ""}), \
             patch("sys.stdin.isatty", return_value=False):
            self.assertFalse(is_executable_skill_allowed(allow_flag=False))


class TestOracleSkillsCli(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / ".git").mkdir()
        self.overlay = self.root / ".canary" / "skills"
        self.overlay.mkdir(parents=True)
        self._cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def test_list_shows_bundled_skills(self):
        from typer.testing import CliRunner
        from agent.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["skills", "list"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("Bundled skills", result.output)

    def test_list_shows_overlay_group(self):
        from typer.testing import CliRunner
        from unittest.mock import patch
        from agent.cli import app

        with tempfile.TemporaryDirectory() as home:
            sk = (
                Path(home) / ".canary" / "overlays"
                / "example-org-example-overlay" / ".canary" / "skills" / "ov-skill"
            )
            sk.mkdir(parents=True)
            (sk / "SKILL.md").write_text(
                "---\nname: ov-skill\n---\n\n# ov-skill\n", encoding="utf-8"
            )
            runner = CliRunner()
            with patch("agent.core.skill_registry.Path.home", return_value=Path(home)):
                result = runner.invoke(app, ["skills", "list"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("Overlay skills (example-org-example-overlay", result.output)
        self.assertIn("/ov-skill", result.output)

    def test_list_marks_executable_skills(self):
        _write_skill(
            self.overlay, "alpha",
            description="executable", cli="scripts/cli.py",
        )
        from typer.testing import CliRunner
        from agent.cli import app

        os.chdir(self.root)
        runner = CliRunner()
        result = runner.invoke(app, ["skills", "list"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("/alpha", result.output)
        self.assertIn("[cli]", result.output)

    def test_run_unknown_skill_exits_nonzero(self):
        from typer.testing import CliRunner
        from agent.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["skills", "run", "nonexistent"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("No skill named", result.output)

    def test_run_markdown_only_skill_exits_nonzero(self):
        _write_skill(self.overlay, "alpha", description="prose only")
        from typer.testing import CliRunner
        from agent.cli import app

        os.chdir(self.root)
        runner = CliRunner()
        result = runner.invoke(
            app,
            ["skills", "run", "alpha", "--allow-executable-skills"],
        )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("markdown-only", result.output)

    def test_run_without_allow_flag_in_non_tty_refuses(self):
        skill_dir = _write_skill(self.overlay, "alpha", cli="scripts/cli.py")
        (skill_dir / "scripts").mkdir()
        cli_path = skill_dir / "scripts" / "cli.py"
        cli_path.write_text("#!/usr/bin/env python3\n")
        cli_path.chmod(0o755)

        from typer.testing import CliRunner
        from agent.cli import app

        os.chdir(self.root)
        runner = CliRunner()
        result = runner.invoke(app, ["skills", "run", "alpha"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("non-interactive", result.output)

    def test_cli_invocation_succeeds_with_allow_flag(self):
        skill_dir = _write_skill(self.overlay, "alpha", cli="scripts/cli.py")
        (skill_dir / "scripts").mkdir()
        cli_path = skill_dir / "scripts" / "cli.py"
        cli_path.write_text(
            "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n"
        )
        cli_path.chmod(0o755)

        from typer.testing import CliRunner
        from agent.cli import app

        os.chdir(self.root)
        runner = CliRunner()
        result = runner.invoke(
            app,
            [
                "skills", "run", "alpha",
                "--allow-executable-skills",
            ],
        )
        self.assertEqual(result.exit_code, 0, result.output)


if __name__ == "__main__":
    unittest.main()
