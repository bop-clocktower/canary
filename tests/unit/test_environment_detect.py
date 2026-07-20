"""Unit tests for agent/core/environment_detect.py.

Covers the three concrete, testable detection paths of issue #341:
- ``.env`` BASE_URL extraction
- ``playwright.config.*`` suite-hint parsing
- the transparent SDET-vs-manual user-level heuristic

Browser-tab detection (path (a) in #341) is deferred to #343 (Chrome
Extension MCP Bridge) and intentionally not covered here.
"""

import tempfile
import unittest
from pathlib import Path

from agent.core.environment_detect import (
    EnvironmentContext,
    detect_base_url,
    detect_environment,
    detect_user_level,
    parse_playwright_suite_hints,
)


class TestDetectBaseUrl(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_base_url_from_dotenv(self):
        (self.root / ".env").write_text("BASE_URL=https://app.example.com\n")
        url, source = detect_base_url(str(self.root))
        self.assertEqual(url, "https://app.example.com")
        self.assertEqual(source, ".env")

    def test_strips_quotes_and_export_prefix(self):
        (self.root / ".env").write_text('export BASE_URL="https://qa.example.com"\n')
        url, source = detect_base_url(str(self.root))
        self.assertEqual(url, "https://qa.example.com")

    def test_ignores_comments_and_blank_lines(self):
        (self.root / ".env").write_text(
            "# staging config\n\nBASE_URL=https://staging.example.com\n"
        )
        url, _ = detect_base_url(str(self.root))
        self.assertEqual(url, "https://staging.example.com")

    def test_accepts_playwright_base_url_alias(self):
        (self.root / ".env").write_text("PLAYWRIGHT_BASE_URL=https://pw.example.com\n")
        url, source = detect_base_url(str(self.root))
        self.assertEqual(url, "https://pw.example.com")
        self.assertEqual(source, ".env")

    def test_canonical_base_url_wins_over_alias(self):
        (self.root / ".env").write_text(
            "E2E_BASE_URL=https://alias.example.com\n"
            "BASE_URL=https://canonical.example.com\n"
        )
        url, _ = detect_base_url(str(self.root))
        self.assertEqual(url, "https://canonical.example.com")

    def test_falls_back_to_playwright_config_base_url(self):
        (self.root / "playwright.config.ts").write_text(
            "export default defineConfig({ use: { baseURL: 'https://cfg.example.com' } });\n"
        )
        url, source = detect_base_url(str(self.root))
        self.assertEqual(url, "https://cfg.example.com")
        self.assertEqual(source, "playwright.config")

    def test_dotenv_wins_over_playwright_config(self):
        (self.root / ".env").write_text("BASE_URL=https://env.example.com\n")
        (self.root / "playwright.config.ts").write_text(
            "export default { use: { baseURL: 'https://cfg.example.com' } };\n"
        )
        url, source = detect_base_url(str(self.root))
        self.assertEqual(url, "https://env.example.com")
        self.assertEqual(source, ".env")

    def test_ignores_process_env_indirection_in_config(self):
        (self.root / "playwright.config.ts").write_text(
            "export default { use: { baseURL: process.env.BASE_URL } };\n"
        )
        url, source = detect_base_url(str(self.root))
        self.assertIsNone(url)
        self.assertIsNone(source)

    def test_no_signal_returns_none(self):
        url, source = detect_base_url(str(self.root))
        self.assertIsNone(url)
        self.assertIsNone(source)


class TestParsePlaywrightSuiteHints(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_config_returns_none(self):
        suite_type, hints = parse_playwright_suite_hints(str(self.root))
        self.assertIsNone(suite_type)
        self.assertEqual(hints, [])

    def test_e2e_testdir_infers_e2e(self):
        (self.root / "playwright.config.ts").write_text(
            "export default { testDir: './tests/e2e' };\n"
        )
        suite_type, hints = parse_playwright_suite_hints(str(self.root))
        self.assertEqual(suite_type, "e2e")
        self.assertIn("./tests/e2e", hints)

    def test_component_testdir_infers_component(self):
        (self.root / "playwright.config.ts").write_text(
            "export default { testDir: './src/components', testMatch: '**/*.ct.tsx' };\n"
        )
        suite_type, _ = parse_playwright_suite_hints(str(self.root))
        self.assertEqual(suite_type, "component")

    def test_api_testdir_infers_api(self):
        (self.root / "playwright.config.ts").write_text(
            "export default { testDir: './tests/api' };\n"
        )
        suite_type, _ = parse_playwright_suite_hints(str(self.root))
        self.assertEqual(suite_type, "api")

    def test_collects_project_names_as_hints(self):
        (self.root / "playwright.config.ts").write_text(
            "export default { projects: [{ name: 'chromium' }, { name: 'firefox' }] };\n"
        )
        _, hints = parse_playwright_suite_hints(str(self.root))
        self.assertIn("chromium", hints)
        self.assertIn("firefox", hints)

    def test_defaults_to_e2e_when_config_present_but_unspecified(self):
        (self.root / "playwright.config.js").write_text("module.exports = {};\n")
        suite_type, _ = parse_playwright_suite_hints(str(self.root))
        self.assertEqual(suite_type, "e2e")


class TestDetectUserLevel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_code_files_open_signals_sdet(self):
        level, signals, confidence = detect_user_level(
            str(self.root), open_files=["tests/login.spec.ts", "src/api.ts"]
        )
        self.assertEqual(level, "sdet")
        self.assertGreater(confidence, 0.0)
        self.assertTrue(signals)

    def test_docs_and_spreadsheets_signal_manual(self):
        level, _, _ = detect_user_level(
            str(self.root), open_files=["test-cases.xlsx", "regression-plan.md"]
        )
        self.assertEqual(level, "manual")

    def test_test_config_presence_signals_sdet(self):
        (self.root / "playwright.config.ts").write_text("export default {};\n")
        level, signals, _ = detect_user_level(str(self.root), open_files=None)
        self.assertEqual(level, "sdet")
        self.assertTrue(any("config" in s for s in signals))

    def test_manual_cwd_component_signals_manual(self):
        manual_dir = self.root / "manual-test-cases"
        manual_dir.mkdir()
        level, _, _ = detect_user_level(str(manual_dir), open_files=["cases.csv"])
        self.assertEqual(level, "manual")

    def test_no_signal_is_unknown_with_zero_confidence(self):
        level, signals, confidence = detect_user_level(str(self.root), open_files=None)
        self.assertEqual(level, "unknown")
        self.assertEqual(confidence, 0.0)
        self.assertEqual(signals, [])

    def test_confidence_is_bounded(self):
        (self.root / "playwright.config.ts").write_text("export default {};\n")
        (self.root / "package.json").write_text("{}")
        level, _, confidence = detect_user_level(
            str(self.root),
            open_files=["a.spec.ts", "b.test.ts", "c.py"],
        )
        self.assertEqual(level, "sdet")
        self.assertLessEqual(confidence, 1.0)
        self.assertGreaterEqual(confidence, 0.0)


class TestDetectEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_returns_environment_context(self):
        ctx = detect_environment(str(self.root))
        self.assertIsInstance(ctx, EnvironmentContext)

    def test_aggregates_all_paths(self):
        (self.root / ".env").write_text("BASE_URL=https://app.example.com\n")
        (self.root / "playwright.config.ts").write_text(
            "export default { testDir: './tests/e2e' };\n"
        )
        ctx = detect_environment(
            str(self.root), open_files=["tests/e2e/login.spec.ts"]
        )
        self.assertEqual(ctx.base_url, "https://app.example.com")
        self.assertEqual(ctx.base_url_source, ".env")
        self.assertEqual(ctx.suite_type, "e2e")
        self.assertEqual(ctx.user_level, "sdet")

    def test_empty_project_yields_unknown_context(self):
        ctx = detect_environment(str(self.root))
        self.assertIsNone(ctx.base_url)
        self.assertIsNone(ctx.suite_type)
        self.assertEqual(ctx.user_level, "unknown")

    def test_to_dict_is_json_friendly(self):
        (self.root / ".env").write_text("BASE_URL=https://app.example.com\n")
        ctx = detect_environment(str(self.root))
        data = ctx.to_dict()
        self.assertEqual(data["base_url"], "https://app.example.com")
        self.assertIn("user_level", data)
        self.assertIn("suite_type", data)


if __name__ == "__main__":
    unittest.main()
