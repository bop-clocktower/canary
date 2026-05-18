"""Tests for HarnessMigrator — detection, framework mapping, migration, and reporting."""

import json
import unittest
from pathlib import Path
import tempfile

from agent.core.migrator import HarnessMigrator, MigrationContext, MigrationReport


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_harness_project(root: Path, *, language: str = "python", layers: list = None) -> None:
    """Write minimal harness markers into root."""
    layers = layers or []
    config = {
        "version": 1,
        "name": "test-project",
        "language": language,
        "template": {"language": language, "version": 1, "level": "intermediate"},
        "tooling": {"testRunner": "pytest"},
        "layers": layers,
    }
    (root / "harness.config.json").write_text(json.dumps(config))
    (root / ".harness").mkdir(exist_ok=True)
    (root / ".harness" / ".gitignore").write_text("*\n")


# ── detection ─────────────────────────────────────────────────────────────────

class TestDetectHarnessMarkers(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_detects_harness_project_with_both_markers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            ctx = self.migrator.detect(root)
            self.assertTrue(ctx.is_harness_project)

    def test_not_harness_without_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".harness").mkdir()
            ctx = self.migrator.detect(root)
            self.assertFalse(ctx.is_harness_project)

    def test_not_harness_without_harness_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{}")
            ctx = self.migrator.detect(root)
            self.assertFalse(ctx.is_harness_project)

    def test_not_harness_for_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = self.migrator.detect(Path(tmp))
            self.assertFalse(ctx.is_harness_project)


# ── framework detection ───────────────────────────────────────────────────────

class TestDetectFramework(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_detects_playwright_from_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detected_shape, "e2e_ui")

    def test_detects_vitest_from_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "vitest.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")
            self.assertEqual(ctx.detected_shape, "frontend_unit")

    def test_detects_pytest_from_ini(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "pytest.ini").write_text("[pytest]\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")
            self.assertEqual(ctx.detected_shape, "api")

    def test_detects_pytest_from_pyproject_toml(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "pyproject.toml").write_text("[tool.pytest.ini_options]\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")

    def test_detects_k6_from_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "k6.config.js").write_text("export const options = {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "k6")
            self.assertEqual(ctx.detected_shape, "performance")

    def test_falls_back_to_python_language_as_pytest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")

    def test_falls_back_to_playwright_for_typescript_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")

    def test_unknown_framework_when_no_signals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            ctx = self.migrator.detect(root)
            self.assertIsNone(ctx.detected_framework)


# ── existing file preservation ────────────────────────────────────────────────

class TestPreservesExistingTests(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_reports_existing_test_files_as_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            tests_dir = root / "tests"
            tests_dir.mkdir()
            (tests_dir / "test_login.py").write_text("def test_login(): pass\n")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertIn("tests/test_login.py", report.preserved_files)

    def test_does_not_delete_existing_test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            tests_dir = root / "tests"
            tests_dir.mkdir()
            test_file = tests_dir / "test_existing.py"
            test_file.write_text("def test_existing(): pass\n")
            self.migrator.migrate(root, dry_run=False)
            self.assertTrue(test_file.exists())
            self.assertEqual(test_file.read_text(), "def test_existing(): pass\n")


# ── dry-run ───────────────────────────────────────────────────────────────────

class TestDryRun(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_dry_run_creates_no_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            before = set(root.rglob("*"))
            report = self.migrator.migrate(root, dry_run=True)
            after = set(root.rglob("*"))
            self.assertEqual(before, after)
            self.assertTrue(report.dry_run)

    def test_dry_run_still_reports_what_would_be_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertGreater(len(report.would_create), 0)


# ── apply mode ────────────────────────────────────────────────────────────────

class TestApplyMode(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_creates_oracle_config_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            self.migrator.migrate(root, dry_run=False)
            self.assertTrue((root / "pytest.ini").exists())

    def test_creates_oracle_test_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            self.migrator.migrate(root, dry_run=False)
            self.assertTrue((root / "tests").exists())

    def test_skips_existing_config_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            original = "[pytest]\ntestpaths = custom\n"
            (root / "pytest.ini").write_text(original)
            report = self.migrator.migrate(root, dry_run=False)
            self.assertIn("pytest.ini", report.skipped_configs)
            self.assertEqual((root / "pytest.ini").read_text(), original)

    def test_idempotent_when_run_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            self.migrator.migrate(root, dry_run=False)
            report2 = self.migrator.migrate(root, dry_run=False)
            self.assertEqual(len(report2.created_files), 0)


# ── report ────────────────────────────────────────────────────────────────────

class TestMigrationReport(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_report_includes_framework(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertEqual(report.framework, "pytest")

    def test_report_includes_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertIn(report.shape, ("api", "e2e_ui", "frontend_unit", "performance", "unknown"))

    def test_report_has_manual_followups_for_unknown_framework(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertGreater(len(report.manual_followups), 0)

    def test_to_markdown_contains_framework(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("pytest", md)

    def test_to_markdown_contains_dry_run_notice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("dry run", md.lower())

    def test_to_markdown_lists_preserved_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "tests").mkdir()
            (root / "tests" / "test_auth.py").write_text("pass")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("test_auth.py", md)


# ── non-harness project ───────────────────────────────────────────────────────

class TestFrameworkOverride(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_override_replaces_auto_detected_framework(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")  # would auto-detect pytest
            report = self.migrator.migrate(root, dry_run=True, framework="playwright")
            self.assertEqual(report.framework, "playwright")

    def test_override_is_used_for_scaffold_in_apply_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            self.migrator.migrate(root, dry_run=False, framework="vitest")
            self.assertTrue((root / "vitest.config.ts").exists())


class TestNonHarnessProject(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_migrate_raises_for_non_harness_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                self.migrator.migrate(Path(tmp), dry_run=True)

    def test_error_message_mentions_harness_markers(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError) as ctx:
                self.migrator.migrate(Path(tmp), dry_run=True)
            self.assertIn("harness", str(ctx.exception).lower())
