# tests/unit/test_mcp_server.py
"""Unit tests for agent/mcp_server.py — all I/O and intelligence calls mocked."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# fastmcp is an optional MCP framework dependency. Inject a passthrough mock so
# unit tests run without it installed. @mcp.tool() must be an identity decorator
# so the _impl functions remain callable on the module.
if "fastmcp" not in sys.modules:
    _mock_fastmcp = MagicMock()
    _mock_fastmcp.FastMCP.return_value.tool.return_value = lambda f: f
    sys.modules["fastmcp"] = _mock_fastmcp


# ---------------------------------------------------------------------------
# oracle__analyze_file
# ---------------------------------------------------------------------------

class TestAnalyzeFile(unittest.TestCase):

    def test_analyze_file_returns_framework(self):
        """Returns expected keys when file exists."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "login.ts"
            target.write_text("export function login() {}")

            mock_meta = MagicMock()
            mock_pattern = MagicMock()
            mock_pattern.common_imports = ["react"]
            mock_domain = MagicMock()
            mock_domain.functions = ["login"]

            with patch("agent.core.metadata_scanner.MetadataScanner.scan", return_value=mock_meta), \
                 patch("agent.core.pattern_matcher.PatternMatcher.scan", return_value=mock_pattern), \
                 patch("agent.core.domain_scanner.DomainScanner.scan", return_value=mock_domain):
                from agent import mcp_server as srv
                result = srv._analyze_file_impl(str(target))

        self.assertIn(result["framework"], ("playwright", "vitest", "pytest", "k6", "unknown"))
        self.assertIn("imports", result)
        self.assertIn("functions", result)
        self.assertIn("existing_tests", result)
        self.assertIn("context_snippets", result)

    def test_analyze_file_missing_file(self):
        """Returns error dict when file does not exist."""
        from agent import mcp_server as srv
        result = srv._analyze_file_impl("/nonexistent/path/foo.ts")
        self.assertIn("error", result)
        self.assertIn("file not found", result["error"])

    def test_analyze_file_framework_source_field(self):
        """framework_source signals whether framework came from config or suffix."""
        from agent import mcp_server as srv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            (root / "playwright.config.ts").write_text("export default {};")
            target = root / "login.spec.ts"
            target.write_text("import { test } from '@playwright/test';\n")
            result = srv._analyze_file_impl(str(target))
        self.assertEqual(result["framework"], "playwright")
        self.assertEqual(result["framework_source"], "config")

    def test_analyze_file_framework_source_suffix_fallback(self):
        """Without a config file, framework_source is 'suffix' and the value is
        still the conventional suffix mapping."""
        from agent import mcp_server as srv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()  # project boundary, no config files
            target = root / "tests" / "test_x.py"
            target.parent.mkdir()
            target.write_text("def test_thing(): pass\n")
            result = srv._analyze_file_impl(str(target))
        self.assertEqual(result["framework_source"], "suffix")
        self.assertEqual(result["framework"], "pytest")

    def test_analyze_file_file_functions_python(self):
        """file_functions extracts top-level and class-level defs from Python."""
        from agent import mcp_server as srv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            target = root / "mod.py"
            target.write_text(
                "def foo():\n    pass\n\n"
                "async def bar():\n    pass\n\n"
                "class C:\n    def baz(self):\n        pass\n"
            )
            result = srv._analyze_file_impl(str(target))
        self.assertEqual(set(result["file_functions"]), {"foo", "bar", "baz"})

    def test_analyze_file_file_functions_typescript(self):
        """file_functions extracts function and const-arrow definitions from TS."""
        from agent import mcp_server as srv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            target = root / "mod.ts"
            target.write_text(
                "export function alpha() {}\n"
                "async function beta() {}\n"
                "export const gamma = () => {};\n"
                "const delta = async (x: number) => x;\n"
            )
            result = srv._analyze_file_impl(str(target))
        self.assertEqual(
            set(result["file_functions"]),
            {"alpha", "beta", "gamma", "delta"},
        )

    def test_analyze_file_existing_tests_populated(self):
        """existing_tests returns relative paths to discovered test files."""
        from agent import mcp_server as srv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            (root / "tests").mkdir()
            (root / "tests" / "test_one.py").write_text("def test_a(): pass")
            (root / "tests" / "test_two.py").write_text("def test_b(): pass")
            target = root / "src" / "thing.py"
            target.parent.mkdir()
            target.write_text("def thing(): pass")
            result = srv._analyze_file_impl(str(target))
        # Order is sorted; should see both
        self.assertEqual(len(result["existing_tests"]), 2)
        self.assertTrue(
            all("test_" in p for p in result["existing_tests"]),
            result["existing_tests"],
        )


# ---------------------------------------------------------------------------
# oracle__list_frameworks
# ---------------------------------------------------------------------------

class TestListFrameworks(unittest.TestCase):

    def test_list_frameworks_returns_all(self):
        """The tool surfaces exactly the registry's framework names."""
        from agent import mcp_server as srv
        from agent.core.framework_registry import FrameworkRegistry

        result = srv._list_frameworks_impl()
        names = set(result["frameworks"])
        # The contract: list_frameworks mirrors the registry, not a fixed
        # count. Derive the expected set so registry additions don't require
        # editing a magic number here.
        expected = {f["name"] for f in FrameworkRegistry().get_all_frameworks()}
        self.assertEqual(names, expected)
        # Core four must always be among them.
        self.assertTrue({"playwright", "vitest", "pytest", "k6"} <= names)


# ---------------------------------------------------------------------------
# oracle__write_test_file
# ---------------------------------------------------------------------------

class TestWriteTestFile(unittest.TestCase):

    def test_write_test_file_creates_dirs(self):
        """Creates parent directories and writes file; returns written_path."""
        with tempfile.TemporaryDirectory() as tmp:
            deep = Path(tmp) / "nested" / "dir" / "my_test.spec.ts"
            from agent import mcp_server as srv
            result = srv._write_test_file_impl(str(deep), "// test content", "playwright")
            self.assertEqual(result["written_path"], str(deep))
            self.assertTrue(deep.exists())
            self.assertEqual(deep.read_text(), "// test content")

    def test_write_test_file_infers_extension(self):
        """Infers .spec.ts extension when file_path has no suffix."""
        with tempfile.TemporaryDirectory() as tmp:
            no_ext = Path(tmp) / "my_test"
            from agent import mcp_server as srv
            result = srv._write_test_file_impl(str(no_ext), "content", "playwright")
            self.assertTrue(result["written_path"].endswith(".spec.ts"))


# ---------------------------------------------------------------------------
# oracle__run_tests
# ---------------------------------------------------------------------------

class TestRunTests(unittest.TestCase):

    def test_run_tests_pass(self):
        """Returns exit_code=0 and positive passed count."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "test_ok.py"
            test_file.write_text("def test_noop(): pass")
            with patch("agent.core.executor.OracleTestExecutor.execute",
                       return_value=(0, "1 passed in 0.01s", "")):
                from agent import mcp_server as srv
                result = srv._run_tests_impl(str(test_file))
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["failed"], 0)

    def test_run_tests_fail(self):
        """Returns exit_code=1 without raising an exception."""
        with tempfile.TemporaryDirectory() as tmp:
            test_file = Path(tmp) / "test_bad.py"
            test_file.write_text("def test_fail(): assert False")
            with patch("agent.core.executor.OracleTestExecutor.execute",
                       return_value=(1, "", "AssertionError")):
                from agent import mcp_server as srv
                result = srv._run_tests_impl(str(test_file))
        self.assertEqual(result["exit_code"], 1)
        self.assertIsInstance(result, dict)


# ---------------------------------------------------------------------------
# oracle__init_suite
# ---------------------------------------------------------------------------

class TestInitSuite(unittest.TestCase):

    def test_init_suite_creates_files(self):
        """Returns framework name and list of created scaffold items."""
        with tempfile.TemporaryDirectory() as tmp:
            mock_scaffold = {
                "created_files": ["playwright.config.ts"],
                "created_dirs": ["tests/e2e"],
                "skipped_files": [],
            }
            with patch("agent.core.scaffolder.Scaffolder.scaffold", return_value=mock_scaffold):
                from agent import mcp_server as srv
                result = srv._init_suite_impl("playwright", tmp)
        self.assertEqual(result["framework"], "playwright")
        self.assertIn("playwright.config.ts", result["files_created"])
        self.assertIn("tests/e2e", result["files_created"])


# ---------------------------------------------------------------------------
# oracle__migrate
# ---------------------------------------------------------------------------

class TestMigrate(unittest.TestCase):

    def _mock_ctx(self, is_harness=True):
        ctx = MagicMock()
        ctx.is_harness_project = is_harness
        return ctx

    def _mock_dry_report(self):
        report = MagicMock()
        report.framework = "playwright"
        report.dry_run = True
        report.manual_followups = ["Remove harness.config.json"]
        return report

    def _mock_apply_report(self):
        report = MagicMock()
        report.framework = "playwright"
        report.dry_run = False
        report.created_files = ["playwright.config.ts"]
        report.created_dirs = ["tests/e2e"]
        report.skipped_configs = []
        report.manual_followups = []
        return report

    def test_migrate_dry_run(self):
        """Dry-run returns plan with dry_run=true and no files_created."""
        with tempfile.TemporaryDirectory() as tmp:
            with patch("agent.core.migrator.HarnessMigrator.detect", return_value=self._mock_ctx()), \
                 patch("agent.core.migrator.HarnessMigrator.migrate", return_value=self._mock_dry_report()):
                from agent import mcp_server as srv
                result = srv._migrate_impl(tmp, apply=False)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["files_created"], [])

    def test_migrate_apply(self):
        """apply=True returns dry_run=false and populated files_created."""
        with tempfile.TemporaryDirectory() as tmp:
            with patch("agent.core.migrator.HarnessMigrator.detect", return_value=self._mock_ctx()), \
                 patch("agent.core.migrator.HarnessMigrator.migrate", return_value=self._mock_apply_report()):
                from agent import mcp_server as srv
                result = srv._migrate_impl(tmp, apply=True)
        self.assertFalse(result["dry_run"])
        self.assertIn("playwright.config.ts", result["files_created"])

    def test_migrate_no_harness(self):
        """Returns error dict when no harness markers are found."""
        with tempfile.TemporaryDirectory() as tmp:
            with patch("agent.core.migrator.HarnessMigrator.detect",
                       return_value=self._mock_ctx(is_harness=False)):
                from agent import mcp_server as srv
                result = srv._migrate_impl(tmp, apply=False)
        self.assertIn("error", result)
        self.assertIn("no harness.config.json", result["error"])


# ---------------------------------------------------------------------------
# MCP error response
# ---------------------------------------------------------------------------

class TestMcpErrorResponse(unittest.TestCase):

    def test_mcp_server_tool_error_response(self):
        """analyze_file with missing file returns error dict, not an exception."""
        from agent import mcp_server as srv
        result = srv._analyze_file_impl("/does/not/exist.ts")
        self.assertIsInstance(result, dict)
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
