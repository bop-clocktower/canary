"""Tests for skill deployment via canary migrate --overlay."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.migrator import HarnessMigrator
from agent.core.skill_registry import SkillRegistry


# ── helpers ───────────────────────────────────────────────────────────────────


def _make_harness_project(root: Path, framework: str = "playwright") -> None:
    (root / "harness.config.json").write_text(
        json.dumps({"language": "typescript", "framework": framework}),
        encoding="utf-8",
    )
    (root / ".harness").mkdir()
    if framework == "playwright":
        (root / "playwright.config.ts").write_text("export default {};", encoding="utf-8")
    elif framework == "pytest":
        (root / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")


def _make_overlay_skill(
    overlay: Path,
    skill_name: str,
    deploy_to: list[str],
    extra_content: str = "",
) -> Path:
    skill_dir = overlay / ".canary" / "skills" / skill_name
    skill_dir.mkdir(parents=True)
    frontmatter = f"---\nname: {skill_name}\ndeploy_to: [{', '.join(deploy_to)}]\n---\n\n# {skill_name}\n{extra_content}"
    (skill_dir / "SKILL.md").write_text(frontmatter, encoding="utf-8")
    return skill_dir


# ── deploy_to frontmatter parsing ─────────────────────────────────────────────


class TestDeployToFrontmatter(unittest.TestCase):
    def _skill_info(self, deploy_to_line: str):
        with tempfile.TemporaryDirectory() as tmp:
            skill_dir = Path(tmp) / "myskill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: myskill\n{deploy_to_line}\n---\n\n# My skill",
                encoding="utf-8",
            )
            reg = SkillRegistry()
            return reg._parse_nested(skill_dir / "SKILL.md", "myskill", "local")

    def test_list_value_parsed(self):
        info = self._skill_info("deploy_to: [api, e2e]")
        self.assertEqual(info.deploy_to, ["api", "e2e"])

    def test_single_value_in_list(self):
        info = self._skill_info("deploy_to: [api]")
        self.assertEqual(info.deploy_to, ["api"])

    def test_all_sentinel(self):
        info = self._skill_info("deploy_to: [all]")
        self.assertEqual(info.deploy_to, ["all"])

    def test_missing_field_returns_empty(self):
        info = self._skill_info("")
        self.assertEqual(info.deploy_to, [])

    def test_scalar_value_wrapped_in_list(self):
        info = self._skill_info("deploy_to: api")
        self.assertEqual(info.deploy_to, ["api"])

    def test_whitespace_trimmed(self):
        info = self._skill_info("deploy_to: [ api , e2e ]")
        self.assertEqual(info.deploy_to, ["api", "e2e"])


# ── _deploy_skills ────────────────────────────────────────────────────────────


class TestDeploySkills(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "target"
        self.overlay = self.root / "overlay"
        self.target.mkdir()
        self.overlay.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _migrator(self):
        return HarnessMigrator()

    def test_matching_skill_copied_on_apply(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        results = self._migrator()._deploy_skills("e2e_ui", self.overlay, self.target, dry_run=False)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "copied")
        self.assertTrue((self.target / ".canary" / "skills" / "login-helper" / "SKILL.md").exists())

    def test_dry_run_does_not_copy(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        results = self._migrator()._deploy_skills("e2e_ui", self.overlay, self.target, dry_run=True)
        self.assertEqual(results[0].status, "dry_run")
        self.assertFalse((self.target / ".canary" / "skills" / "login-helper").exists())

    def test_non_matching_shape_not_deployed(self):
        _make_overlay_skill(self.overlay, "api-bridge", ["api"])
        results = self._migrator()._deploy_skills("e2e_ui", self.overlay, self.target, dry_run=False)
        self.assertEqual(results, [])

    def test_all_sentinel_deploys_to_any_shape(self):
        _make_overlay_skill(self.overlay, "universal-skill", ["all"])
        results = self._migrator()._deploy_skills("api", self.overlay, self.target, dry_run=False)
        self.assertEqual(results[0].status, "copied")

    def test_already_present_skill_skipped(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        dest = self.target / ".canary" / "skills" / "login-helper"
        dest.mkdir(parents=True)
        (dest / "SKILL.md").write_text("existing", encoding="utf-8")
        results = self._migrator()._deploy_skills("e2e_ui", self.overlay, self.target, dry_run=False)
        self.assertEqual(results[0].status, "skipped")
        self.assertEqual((dest / "SKILL.md").read_text(), "existing")

    def test_no_deploy_to_field_not_deployed(self):
        skill_dir = self.overlay / ".canary" / "skills" / "markdown-only"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("---\nname: markdown-only\n---\n\n# Skill", encoding="utf-8")
        results = self._migrator()._deploy_skills("api", self.overlay, self.target, dry_run=False)
        self.assertEqual(results, [])

    def test_multiple_skills_filtered_by_shape(self):
        _make_overlay_skill(self.overlay, "api-bridge", ["api"])
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui", "api"])
        _make_overlay_skill(self.overlay, "ui-bridge", ["e2e_ui"])
        results = self._migrator()._deploy_skills("api", self.overlay, self.target, dry_run=False)
        deployed = {r.skill_name for r in results if r.status == "copied"}
        self.assertIn("api-bridge", deployed)
        self.assertIn("login-helper", deployed)
        self.assertNotIn("ui-bridge", deployed)

    def test_none_overlay_returns_empty(self):
        results = self._migrator()._deploy_skills("api", None, self.target, dry_run=False)
        self.assertEqual(results, [])

    def test_overlay_extra_files_copied_with_skill(self):
        skill_dir = _make_overlay_skill(self.overlay, "rich-skill", ["api"])
        (skill_dir / "helpers.py").write_text("# helper", encoding="utf-8")
        self._migrator()._deploy_skills("api", self.overlay, self.target, dry_run=False)
        self.assertTrue((self.target / ".canary" / "skills" / "rich-skill" / "helpers.py").exists())


# ── migrate() integration ─────────────────────────────────────────────────────


class TestMigrateWithSkillDeployment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "target"
        self.overlay = self.root / "overlay"
        self.target.mkdir()
        self.overlay.mkdir()
        _make_harness_project(self.target, "playwright")

    def tearDown(self):
        self.tmp.cleanup()

    def test_migrate_deploys_matching_skills(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        self.assertEqual(len(report.deployed_skills), 1)
        self.assertEqual(report.deployed_skills[0].status, "copied")

    def test_migrate_dry_run_reports_but_does_not_copy(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=True, overlay_path=self.overlay
        )
        self.assertEqual(report.deployed_skills[0].status, "dry_run")
        self.assertFalse((self.target / ".canary" / "skills" / "login-helper").exists())

    def test_migrate_without_overlay_no_deployed_skills(self):
        report = HarnessMigrator().migrate(self.target, dry_run=True)
        self.assertEqual(report.deployed_skills, [])

    def test_to_markdown_includes_skill_section(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        md = report.to_markdown()
        self.assertIn("Skills Deployed", md)
        self.assertIn("login-helper", md)

    def test_to_markdown_dry_run_skill_section(self):
        _make_overlay_skill(self.overlay, "login-helper", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=True, overlay_path=self.overlay
        )
        md = report.to_markdown()
        self.assertIn("would deploy", md)
        self.assertIn("login-helper", md)


if __name__ == "__main__":
    unittest.main()
