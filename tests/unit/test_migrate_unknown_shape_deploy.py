"""Regression: overlay skills deploy even when the framework can't be detected.

Gap 4 of issue #310, guarding the #295 fix landed in #307. Before the fix, a
migrate() run that failed framework detection returned early with a "couldn't
detect" follow-up and deployed *nothing* — including framework-agnostic
``deploy_to: [all]`` skills that had no reason to be withheld. The corrected
behavior drives ``_deploy_skills`` on the unknown branch too:

  * ``deploy_to: [all]`` skills deploy regardless of shape (they are
    framework-agnostic);
  * shape-specific skills are still skipped when the shape is ``unknown``
    (we genuinely don't know which to pick — skipping is correct);
  * the "couldn't auto-detect" follow-up is still surfaced.

A less-common framework path (wdio → ``mobile``) is covered too, to prove the
shape-gated branch keeps working end-to-end for the long tail.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.migrator import HarnessMigrator


def _harness_project(root: Path, config: dict) -> None:
    (root / "harness.config.json").write_text(json.dumps(config), encoding="utf-8")
    (root / ".harness").mkdir()


def _overlay_skill(overlay: Path, name: str, deploy_to: list[str]) -> None:
    skill_dir = overlay / ".canary" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndeploy_to: [{', '.join(deploy_to)}]\n---\n\n# {name}\n",
        encoding="utf-8",
    )


class TestUnknownShapeDeployment(unittest.TestCase):
    """framework=unknown / shape=unknown must still deploy deploy_to:[all]."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "target"
        self.overlay = self.root / "overlay"
        self.target.mkdir()
        self.overlay.mkdir()
        # No language, no config files, no package.json → detection returns None.
        _harness_project(self.target, {"name": "mystery"})

    def tearDown(self):
        self.tmp.cleanup()

    def test_detection_is_genuinely_unknown(self):
        """Premise check: this fixture really does defeat detection."""
        ctx = HarnessMigrator().detect(self.target)
        self.assertIsNone(ctx.detected_framework)
        self.assertEqual(ctx.detected_shape, "unknown")

    def test_all_sentinel_skill_deploys_despite_unknown_framework(self):
        _overlay_skill(self.overlay, "universal-helper", ["all"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        self.assertEqual(report.framework, "unknown")
        self.assertEqual(report.shape, "unknown")
        deployed = {r.skill_name for r in report.deployed_skills if r.status == "copied"}
        self.assertIn("universal-helper", deployed)
        self.assertTrue(
            (self.target / ".canary" / "skills" / "universal-helper" / "SKILL.md").exists()
        )

    def test_shape_specific_skill_skipped_when_shape_unknown(self):
        _overlay_skill(self.overlay, "ui-only", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        # Not deployed — an unknown shape can't match e2e_ui.
        names = {r.skill_name for r in report.deployed_skills}
        self.assertNotIn("ui-only", names)
        self.assertFalse((self.target / ".canary" / "skills" / "ui-only").exists())

    def test_mixed_overlay_only_all_sentinel_survives(self):
        _overlay_skill(self.overlay, "universal-helper", ["all"])
        _overlay_skill(self.overlay, "ui-only", ["e2e_ui"])
        _overlay_skill(self.overlay, "api-only", ["api"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        copied = {r.skill_name for r in report.deployed_skills if r.status == "copied"}
        self.assertEqual(copied, {"universal-helper"})

    def test_unknown_branch_still_reports_detection_followup(self):
        _overlay_skill(self.overlay, "universal-helper", ["all"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        # Deployment happening must NOT suppress the "couldn't detect" guidance.
        self.assertTrue(report.manual_followups)
        self.assertTrue(any("framework" in f.lower() for f in report.manual_followups))

    def test_dry_run_unknown_branch_reports_all_sentinel_without_copying(self):
        _overlay_skill(self.overlay, "universal-helper", ["all"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=True, overlay_path=self.overlay
        )
        statuses = {r.skill_name: r.status for r in report.deployed_skills}
        self.assertEqual(statuses.get("universal-helper"), "dry_run")
        self.assertFalse((self.target / ".canary" / "skills" / "universal-helper").exists())


class TestLessCommonFrameworkDeployment(unittest.TestCase):
    """A long-tail framework (wdio → mobile) still deploys its shape skill."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.target = self.root / "target"
        self.overlay = self.root / "overlay"
        self.target.mkdir()
        self.overlay.mkdir()
        _harness_project(self.target, {"language": "typescript"})
        # wdio config file → framework=wdio, shape=mobile (a config-probe path).
        (self.target / "wdio.conf.js").write_text("exports.config = {};", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_wdio_detected_as_mobile_shape(self):
        ctx = HarnessMigrator().detect(self.target)
        self.assertEqual(ctx.detected_framework, "wdio")
        self.assertEqual(ctx.detected_shape, "mobile")

    def test_mobile_shape_skill_deploys_and_ui_skill_skipped(self):
        _overlay_skill(self.overlay, "mobile-helper", ["mobile"])
        _overlay_skill(self.overlay, "ui-only", ["e2e_ui"])
        report = HarnessMigrator().migrate(
            self.target, dry_run=False, overlay_path=self.overlay
        )
        self.assertEqual(report.framework, "wdio")
        self.assertEqual(report.shape, "mobile")
        copied = {r.skill_name for r in report.deployed_skills if r.status == "copied"}
        self.assertIn("mobile-helper", copied)
        self.assertNotIn("ui-only", copied)


if __name__ == "__main__":
    unittest.main()
