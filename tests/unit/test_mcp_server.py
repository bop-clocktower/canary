# tests/unit/test_mcp_server.py
"""Unit tests for agent/mcp_server.py — all I/O and intelligence calls mocked."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# oracle__analyze_file
# ---------------------------------------------------------------------------

class TestAnalyzeFile:
    def test_analyze_file_returns_framework(self, tmp_path):
        """Returns expected keys when file exists."""
        target = tmp_path / "login.ts"
        target.write_text("export function login() {}")

        mock_meta = MagicMock()
        mock_meta.js_dependencies = {"react": "^18.0.0"}

        mock_pattern = MagicMock()
        mock_pattern.is_empty = False
        mock_pattern.common_imports = ["react"]
        mock_pattern.sample_names = ["test_login"]

        mock_domain = MagicMock()
        mock_domain.components = ["LoginForm"]
        mock_domain.functions = ["login"]
        mock_domain.api_routes = []

        with (
            patch("agent.core.metadata_scanner.MetadataScanner.scan", return_value=mock_meta),
            patch("agent.core.pattern_matcher.PatternMatcher.scan", return_value=mock_pattern),
            patch("agent.core.domain_scanner.DomainScanner.scan", return_value=mock_domain),
        ):
            from agent import mcp_server as srv
            result = srv._analyze_file_impl(str(target))

        assert result["framework"] in ("playwright", "vitest", "pytest", "k6", "unknown")
        assert "imports" in result
        assert "functions" in result
        assert "existing_tests" in result
        assert "context_snippets" in result

    def test_analyze_file_missing_file(self):
        """Returns error dict when file does not exist."""
        from agent import mcp_server as srv
        result = srv._analyze_file_impl("/nonexistent/path/foo.ts")
        assert "error" in result
        assert "file not found" in result["error"]


# ---------------------------------------------------------------------------
# oracle__list_frameworks
# ---------------------------------------------------------------------------

class TestListFrameworks:
    def test_list_frameworks_returns_all(self):
        """Returns all four registry frameworks."""
        from agent import mcp_server as srv
        result = srv._list_frameworks_impl()
        assert set(result["frameworks"]) == {"playwright", "vitest", "pytest", "k6"}


# ---------------------------------------------------------------------------
# oracle__write_test_file
# ---------------------------------------------------------------------------

class TestWriteTestFile:
    def test_write_test_file_creates_dirs(self, tmp_path):
        """Creates parent directories and writes file; returns written_path."""
        deep = tmp_path / "nested" / "dir" / "my_test.spec.ts"
        from agent import mcp_server as srv
        result = srv._write_test_file_impl(str(deep), "// test content", "playwright")
        assert result["written_path"] == str(deep)
        assert deep.exists()
        assert deep.read_text() == "// test content"

    def test_write_test_file_infers_extension(self, tmp_path):
        """Infers .spec.ts extension when file_path has no suffix."""
        no_ext = tmp_path / "my_test"
        from agent import mcp_server as srv
        result = srv._write_test_file_impl(str(no_ext), "content", "playwright")
        assert result["written_path"].endswith(".spec.ts")


# ---------------------------------------------------------------------------
# oracle__run_tests
# ---------------------------------------------------------------------------

class TestRunTests:
    def test_run_tests_pass(self, tmp_path):
        """Returns exit_code=0 and positive passed count."""
        test_file = tmp_path / "test_ok.py"
        test_file.write_text("def test_noop(): pass")

        with patch(
            "agent.core.executor.OracleTestExecutor.execute",
            return_value=(0, "1 passed in 0.01s", ""),
        ):
            from agent import mcp_server as srv
            result = srv._run_tests_impl(str(test_file))

        assert result["exit_code"] == 0
        assert result["failed"] == 0

    def test_run_tests_fail(self, tmp_path):
        """Returns exit_code=1 without raising an exception."""
        test_file = tmp_path / "test_bad.py"
        test_file.write_text("def test_fail(): assert False")

        with patch(
            "agent.core.executor.OracleTestExecutor.execute",
            return_value=(1, "", "AssertionError"),
        ):
            from agent import mcp_server as srv
            result = srv._run_tests_impl(str(test_file))

        assert result["exit_code"] == 1
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# oracle__init_suite
# ---------------------------------------------------------------------------

class TestInitSuite:
    def test_init_suite_creates_files(self, tmp_path):
        """Returns framework name and list of created scaffold items."""
        mock_scaffold_result = {
            "created_files": ["playwright.config.ts"],
            "created_dirs": ["tests/e2e"],
            "skipped_files": [],
        }
        with patch(
            "agent.core.scaffolder.Scaffolder.scaffold",
            return_value=mock_scaffold_result,
        ):
            from agent import mcp_server as srv
            result = srv._init_suite_impl("playwright", str(tmp_path))

        assert result["framework"] == "playwright"
        assert "playwright.config.ts" in result["files_created"]
        assert "tests/e2e" in result["files_created"]


# ---------------------------------------------------------------------------
# oracle__migrate
# ---------------------------------------------------------------------------

class TestMigrate:
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

    def test_migrate_dry_run(self, tmp_path):
        """Dry-run returns plan with dry_run=true and no files_created."""
        with (
            patch("agent.core.migrator.HarnessMigrator.detect",
                  return_value=self._mock_ctx()),
            patch("agent.core.migrator.HarnessMigrator.migrate",
                  return_value=self._mock_dry_report()),
        ):
            from agent import mcp_server as srv
            result = srv._migrate_impl(str(tmp_path), apply=False)

        assert result["dry_run"] is True
        assert result["files_created"] == []

    def test_migrate_apply(self, tmp_path):
        """apply=True returns dry_run=false and populated files_created."""
        with (
            patch("agent.core.migrator.HarnessMigrator.detect",
                  return_value=self._mock_ctx()),
            patch("agent.core.migrator.HarnessMigrator.migrate",
                  return_value=self._mock_apply_report()),
        ):
            from agent import mcp_server as srv
            result = srv._migrate_impl(str(tmp_path), apply=True)

        assert result["dry_run"] is False
        assert "playwright.config.ts" in result["files_created"]

    def test_migrate_no_harness(self, tmp_path):
        """Returns error dict when no harness markers are found."""
        with patch(
            "agent.core.migrator.HarnessMigrator.detect",
            return_value=self._mock_ctx(is_harness=False),
        ):
            from agent import mcp_server as srv
            result = srv._migrate_impl(str(tmp_path), apply=False)

        assert "error" in result
        assert "no harness.config.json" in result["error"]


# ---------------------------------------------------------------------------
# MCP error response (tool-level error does not raise Python exception)
# ---------------------------------------------------------------------------

class TestMcpErrorResponse:
    def test_mcp_server_tool_error_response(self):
        """analyze_file with missing file returns error dict, not an exception."""
        from agent import mcp_server as srv
        result = srv._analyze_file_impl("/does/not/exist.ts")
        assert isinstance(result, dict)
        assert "error" in result
