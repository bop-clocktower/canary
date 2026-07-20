"""Tests for the overlay freshness gate (issue #334).

`HarnessMigrator.check_freshness` compares an overlay's deployable skills against
what the consuming repo carries and classifies each as current / stale / missing
/ local_edit. Deployment stays strictly one-way (the overlay owns deployed
files): a skill with local edits is never overwritten and is reported so an
auto-update PR can never clobber hand modifications.

The apply-side companion (`migrate --apply`) refreshes provably-stale skills
(target still matches the deploy manifest, overlay moved on) but skips
locally-edited ones.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.migrator import HarnessMigrator


def _make_harness_project(root: Path, *, language: str = "python") -> None:
    (root / "harness.config.json").write_text(
        json.dumps({"language": language, "layers": []}), encoding="utf-8"
    )
    (root / ".harness").mkdir(exist_ok=True)


def _overlay_with_skill(overlay: Path, dir_name: str, body: str, deploy_to: str = "all") -> Path:
    skill_dir = overlay / ".canary" / "skills" / dir_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {dir_name}\ndeploy_to: [{deploy_to}]\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return skill_dir


class TestFreshnessInSync(unittest.TestCase):
    def test_identical_deployed_skill_is_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            m = HarnessMigrator()
            m.migrate(root, dry_run=False, overlay_path=overlay)  # deploy
            report = m.check_freshness(root, overlay_path=overlay)
            self.assertTrue(report.in_sync)
            self.assertFalse(report.has_drift)
            self.assertFalse(report.has_local_edits)
            self.assertEqual([r.status for r in report.results], ["current"])


class TestFreshnessDrift(unittest.TestCase):
    def test_missing_skill_is_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            report = HarnessMigrator().check_freshness(root, overlay_path=overlay)
            self.assertTrue(report.has_drift)
            self.assertEqual(report.results[0].status, "missing")

    def test_updated_overlay_makes_deployed_skill_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            m = HarnessMigrator()
            m.migrate(root, dry_run=False, overlay_path=overlay)  # deploy v1
            _overlay_with_skill(overlay, "demo", "# demo v2 — new guidance")  # overlay moves on
            report = m.check_freshness(root, overlay_path=overlay)
            self.assertTrue(report.has_drift)
            self.assertFalse(report.has_local_edits)
            self.assertEqual(report.results[0].status, "stale")


class TestFreshnessLocalEdits(unittest.TestCase):
    def test_locally_edited_deployed_skill_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            m = HarnessMigrator()
            m.migrate(root, dry_run=False, overlay_path=overlay)  # deploy v1
            # Hand-edit the deployed copy (overlay unchanged).
            (root / ".canary" / "skills" / "demo" / "SKILL.md").write_text(
                "---\nname: demo\ndeploy_to: [all]\n---\n\n# demo — hand tweaked locally\n",
                encoding="utf-8",
            )
            report = m.check_freshness(root, overlay_path=overlay)
            self.assertTrue(report.has_local_edits)
            self.assertFalse(report.has_drift)
            self.assertEqual(report.results[0].status, "local_edit")

    def test_deployed_without_provenance_and_differing_is_treated_as_local_edit(self):
        """A pre-existing hand-placed skill (no deploy manifest) that differs from
        the overlay is conservatively treated as a local edit — never silently
        overwritten."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            # Hand-place a differing skill directly, no manifest.
            dest = root / ".canary" / "skills" / "demo"
            dest.mkdir(parents=True)
            (dest / "SKILL.md").write_text(
                "---\nname: demo\ndeploy_to: [all]\n---\n\n# demo — my own\n",
                encoding="utf-8",
            )
            report = HarnessMigrator().check_freshness(root, overlay_path=overlay)
            self.assertEqual(report.results[0].status, "local_edit")


class TestFreshnessReportRendering(unittest.TestCase):
    def test_markdown_names_skills_and_statuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            md = HarnessMigrator().check_freshness(root, overlay_path=overlay).to_markdown()
            self.assertIn("demo", md)
            self.assertIn("missing", md.lower())

    def test_non_harness_project_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                HarnessMigrator().check_freshness(Path(tmp), overlay_path=None)


class TestApplyRefreshesStaleButSkipsLocalEdits(unittest.TestCase):
    def test_apply_overwrites_stale_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            m = HarnessMigrator()
            m.migrate(root, dry_run=False, overlay_path=overlay)
            _overlay_with_skill(overlay, "demo", "# demo v2 — new guidance")
            report = m.migrate(root, dry_run=False, overlay_path=overlay)
            deployed = root / ".canary" / "skills" / "demo" / "SKILL.md"
            self.assertIn("v2", deployed.read_text())
            statuses = {r.skill_name: r.status for r in report.deployed_skills}
            self.assertEqual(statuses["demo"], "updated")
            # After apply, the freshness gate is clean again.
            self.assertTrue(m.check_freshness(root, overlay_path=overlay).in_sync)

    def test_apply_never_overwrites_local_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root, overlay = base / "proj", base / "overlay"
            root.mkdir()
            _make_harness_project(root)
            _overlay_with_skill(overlay, "demo", "# demo v1")
            m = HarnessMigrator()
            m.migrate(root, dry_run=False, overlay_path=overlay)
            edited = "---\nname: demo\ndeploy_to: [all]\n---\n\n# demo — precious local work\n"
            (root / ".canary" / "skills" / "demo" / "SKILL.md").write_text(edited, encoding="utf-8")
            # Overlay also moved on — but the local edit wins the safety rule.
            _overlay_with_skill(overlay, "demo", "# demo v2")
            report = m.migrate(root, dry_run=False, overlay_path=overlay)
            self.assertEqual(
                (root / ".canary" / "skills" / "demo" / "SKILL.md").read_text(), edited
            )
            statuses = {r.skill_name: r.status for r in report.deployed_skills}
            self.assertEqual(statuses["demo"], "skipped")


if __name__ == "__main__":
    unittest.main()
