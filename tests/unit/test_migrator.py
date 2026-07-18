"""Tests for HarnessMigrator — detection, framework mapping, migration, and reporting."""

import json
import unittest
from pathlib import Path
import tempfile

from agent.core.migrator import HarnessMigrator


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

    def test_playwright_api_suite_detected_when_no_page_fixtures(self):
        """Playwright suites with no page/browser fixture usage → shape api."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            tests_dir = root / "tests" / "challenges"
            tests_dir.mkdir(parents=True)
            (tests_dir / "enroll.spec.ts").write_text(
                "test('enroll', async ({api, user}) => { const r = await api.challenges.enroll(); });\n"
            )
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detected_shape, "api")

    def test_playwright_ui_suite_stays_e2e_ui_when_page_fixture_present(self):
        """Playwright suites with page fixture usage → shape e2e_ui."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            tests_dir = root / "tests"
            tests_dir.mkdir(parents=True)
            (tests_dir / "login.spec.ts").write_text(
                "test('login', async ({ page }) => { await page.goto('/login'); });\n"
            )
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detected_shape, "e2e_ui")

    def test_playwright_api_shape_via_company_json_override(self):
        """canary_shape in company.json overrides heuristic detection."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            # UI fixture present — would normally be e2e_ui
            tests_dir = root / "tests"
            tests_dir.mkdir(parents=True)
            (tests_dir / "ui.spec.ts").write_text(
                "test('ui', async ({ page }) => { await page.goto('/'); });\n"
            )
            canary_dir = root / ".canary"
            canary_dir.mkdir()
            (canary_dir / "company.json").write_text('{"canary_shape": "api"}')
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "api")

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
            self.assertIn(report.shape, ("api", "e2e_ui", "frontend_unit", "performance", "mobile", "unknown"))

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


# ── improvement 1: extended framework detection ───────────────────────────────

class TestExtendedConfigFileDetection(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_detects_jest_config_ts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "jest.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")
            self.assertEqual(ctx.detected_shape, "frontend_unit")

    def test_detects_jest_config_js(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="javascript")
            (root / "jest.config.js").write_text("module.exports = {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")

    def test_detects_cypress_config_ts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "cypress.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detected_shape, "e2e_ui")

    def test_detects_vitest_config_mts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "vitest.config.mts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")

    def test_detects_locustfile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "locustfile.py").write_text("from locust import HttpUser\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "locust")
            self.assertEqual(ctx.detected_shape, "load")

    def test_detects_backstop_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="javascript")
            (root / "backstop.json").write_text("{}")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "backstopjs")
            self.assertEqual(ctx.detected_shape, "visual")

    def test_detects_stryker_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "stryker.config.js").write_text("module.exports = {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "stryker")
            self.assertEqual(ctx.detected_shape, "mutation")


class TestPackageJsonDetection(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def _make_pkg(self, root: Path, test_script: str) -> None:
        _make_harness_project(root, language="typescript")
        (root / "package.json").write_text(
            json.dumps({"scripts": {"test": test_script}})
        )

    def test_detects_playwright_from_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_pkg(root, "playwright test")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detection_source, "package.json (scripts.test)")
            self.assertEqual(ctx.detection_confidence, "content")

    def test_detects_vitest_from_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_pkg(root, "vitest run")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")

    def test_detects_jest_from_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_pkg(root, "jest --coverage")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "vitest")

    def test_config_file_takes_precedence_over_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_pkg(root, "jest --coverage")
            (root / "playwright.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            # Config file probe wins
            self.assertEqual(ctx.detected_framework, "playwright")
            self.assertEqual(ctx.detection_confidence, "config")


class TestRequirementsTxtDetection(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_detects_pytest_from_requirements_txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements.txt").write_text("pytest>=7.0\nrequests\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")
            self.assertEqual(ctx.detection_source, "requirements.txt")
            self.assertEqual(ctx.detection_confidence, "content")

    def test_detects_locust_from_requirements_txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements.txt").write_text("locust==2.17\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "locust")
            self.assertEqual(ctx.detected_shape, "load")

    def test_detects_from_requirements_dev_txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements-dev.txt").write_text("pytest\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")
            self.assertEqual(ctx.detection_source, "requirements-dev.txt")

    def test_detects_pytest_from_pyproject_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            # requirements-style lines in pyproject extras (pip-tools / poetry lock output)
            (root / "pyproject.toml").write_text(
                "[tool.poetry.dependencies]\npytest = \"^7.0\"\nrequests = \"*\"\n"
            )
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "pytest")
            self.assertEqual(ctx.detection_source, "pyproject.toml (dependencies)")


# ── improvement 2: detection source and confidence ────────────────────────────

class TestDetectionSourceAndConfidence(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_config_file_yields_high_confidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detection_confidence, "config")
            self.assertEqual(ctx.detection_source, "playwright.config.ts")

    def test_language_fallback_yields_low_confidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detection_confidence, "language")
            self.assertIn("python", ctx.detection_source)

    def test_no_detection_yields_none_confidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detection_confidence, "none")
            self.assertIsNone(ctx.detected_framework)

    def test_report_includes_detection_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertEqual(report.detection_source, "playwright.config.ts")
            self.assertEqual(report.detection_confidence, "config")

    def test_markdown_shows_detection_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root)
            (root / "playwright.config.ts").write_text("export default {};")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("playwright.config.ts", md)
            self.assertIn("high", md)

    def test_markdown_shows_medium_confidence_for_content_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements.txt").write_text("pytest\n")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("medium", md)

    def test_cli_override_recorded_in_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            report = self.migrator.migrate(root, dry_run=True, framework="vitest")
            self.assertEqual(report.detection_source, "CLI override")

    def test_dry_run_shows_already_present_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "pytest.ini").write_text("[pytest]\n")
            report = self.migrator.migrate(root, dry_run=True)
            self.assertIn("pytest.ini", report.skipped_configs)

    def test_dry_run_markdown_shows_already_present_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "pytest.ini").write_text("[pytest]\n")
            report = self.migrator.migrate(root, dry_run=True)
            md = report.to_markdown()
            self.assertIn("Already Present", md)


# ── improvement 3: new config shapes ─────────────────────────────────────────

class TestNewConfigShapes(unittest.TestCase):

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_detects_accessibility_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="javascript")
            (root / "axe.config.js").write_text("module.exports = {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "accessibility")
            self.assertEqual(ctx.detected_framework, "axe-core")

    def test_detects_visual_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="javascript")
            (root / "backstop.json").write_text("{}")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "visual")
            self.assertEqual(ctx.detected_framework, "backstopjs")

    def test_detects_contract_shape_from_pact_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "pact.json").write_text("{}")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "contract")
            self.assertEqual(ctx.detected_framework, "pact")

    def test_detects_mutation_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "stryker.config.mjs").write_text("export default {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "mutation")
            self.assertEqual(ctx.detected_framework, "stryker")

    def test_detects_load_shape_from_locust_conf(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "locust.conf").write_text("[locust]\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "load")
            self.assertEqual(ctx.detected_framework, "locust")

    def test_detects_synthetic_data_from_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements.txt").write_text("faker==20.0\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "synthetic_data")
            self.assertEqual(ctx.detected_framework, "faker")

    def test_detects_integration_shape_from_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            (root / "requirements.txt").write_text("testcontainers\n")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_shape, "integration")
            self.assertEqual(ctx.detected_framework, "testcontainers")

    def test_detects_wdio_from_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "wdio.conf.ts").write_text("export const config = {};")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "wdio")
            self.assertEqual(ctx.detected_shape, "mobile")

    def test_detects_wdio_from_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="typescript")
            (root / "package.json").write_text(
                json.dumps({"scripts": {"test": "wdio run wdio.conf.ts"}})
            )
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.detected_framework, "wdio")
            self.assertEqual(ctx.detected_shape, "mobile")


# ── fix #3: fail-loud framework detection (#295) ───────────────────────────────

class TestUnknownFrameworkFailsLoud(unittest.TestCase):
    """When framework detection is uncertain, `migrate` must emit a clear,
    actionable followup naming the known frameworks and the override flag —
    not just a bare 'Framework: unknown'. See issue #295."""

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_unknown_followup_lists_known_frameworks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            report = self.migrator.migrate(root, dry_run=True)
            joined = " ".join(report.manual_followups)
            self.assertIn("playwright", joined)
            self.assertIn("pytest", joined)
            self.assertIn("wdio", joined)

    def test_unknown_followup_mentions_override_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            report = self.migrator.migrate(root, dry_run=True)
            joined = " ".join(report.manual_followups)
            self.assertIn("--framework", joined)

    def test_unknown_followup_is_actionable_not_bare_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="unknown-lang")
            report = self.migrator.migrate(root, dry_run=True)
            joined = " ".join(report.manual_followups).lower()
            self.assertIn("auto-detect", joined)

    def test_deploy_to_all_skills_deploy_even_when_framework_unknown(self):
        """Issue #295 point 3: a detection miss must not block deploy_to:[all]
        overlay skills — they should still deploy so migrate degrades
        gracefully instead of deploying nothing."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "proj"
            root.mkdir()
            _make_harness_project(root, language="unknown-lang")  # framework unknown
            overlay = base / "overlay"
            skill_dir = overlay / ".canary" / "skills" / "universal-skill"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: universal-skill\ndeploy_to: [all]\n---\n\n# universal-skill\n",
                encoding="utf-8",
            )
            report = self.migrator.migrate(root, dry_run=True, overlay_path=overlay)
            deployed_names = [r.skill_name for r in report.deployed_skills]
            self.assertIn("universal-skill", deployed_names)


# ── fix #2: config-validation fail-fast (malformed configs warn, not swallow) ──

class TestConfigValidationWarnings(unittest.TestCase):
    """A malformed (but present) harness.config.json / company.json must
    produce a clear warning instead of silently behaving as if the file
    were absent. See agent/core/config_validation.py."""

    def setUp(self):
        self.migrator = HarnessMigrator()

    def test_malformed_harness_config_json_yields_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            ctx = self.migrator.detect(root)
            self.assertTrue(ctx.is_harness_project)
            self.assertTrue(
                any("harness.config.json" in w for w in ctx.config_warnings),
                ctx.config_warnings,
            )

    def test_malformed_harness_config_json_does_not_crash_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            # Should not raise, and should fall back to an empty config
            # (same behavior as before, just with a warning attached now).
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.harness_config, {})

    def test_well_formed_harness_config_json_has_no_warnings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            ctx = self.migrator.detect(root)
            self.assertEqual(ctx.config_warnings, [])

    def test_malformed_company_json_yields_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_harness_project(root, language="python")
            canary_dir = root / ".canary"
            canary_dir.mkdir()
            (canary_dir / "company.json").write_text("{broken", encoding="utf-8")
            ctx = self.migrator.detect(root)
            self.assertTrue(
                any("company.json" in w for w in ctx.config_warnings),
                ctx.config_warnings,
            )

    def test_config_warnings_propagate_to_migration_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            report = self.migrator.migrate(root, dry_run=True, framework="pytest")
            self.assertTrue(
                any("harness.config.json" in w for w in report.config_warnings),
                report.config_warnings,
            )

    def test_config_warnings_rendered_in_markdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            report = self.migrator.migrate(root, dry_run=True, framework="pytest")
            md = report.to_markdown()
            self.assertIn("Warning", md)
            self.assertIn("harness.config.json", md)

    def test_malformed_config_does_not_hard_fail_migrate(self):
        """A malformed config warns but never raises — CI pipelines with
        quirky-but-tolerated configs must not break on upgrade."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "harness.config.json").write_text("{not valid json", encoding="utf-8")
            (root / ".harness").mkdir()
            try:
                report = self.migrator.migrate(root, dry_run=True, framework="pytest")
            except Exception as exc:  # pragma: no cover - assertion is the point
                self.fail(f"migrate() raised on malformed config: {exc}")
            self.assertEqual(report.framework, "pytest")
