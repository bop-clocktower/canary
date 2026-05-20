from __future__ import annotations

# agent/mcp_server.py
"""Oracle MCP server — exposes Oracle intelligence tools to Claude Code."""

import os
from pathlib import Path

from fastmcp import FastMCP

from agent.core.metadata_scanner import MetadataScanner
from agent.core.pattern_matcher import PatternMatcher
from agent.core.domain_scanner import DomainScanner
from agent.core.executor import OracleTestExecutor
from agent.core.framework_registry import FrameworkRegistry
from agent.core.scaffolder import Scaffolder
from agent.core.migrator import HarnessMigrator

mcp = FastMCP("oracle")

_WORKING_DIR = os.environ.get("CLAUDE_PLUGIN_ROOT", os.getcwd())


# ---------------------------------------------------------------------------
# Internal implementation functions (importable for unit tests without MCP)
# ---------------------------------------------------------------------------

def _analyze_file_impl(file_path: str) -> dict:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"file not found: {file_path}"}

    project_root = str(path.parent)
    meta = MetadataScanner().scan(project_root)
    pattern = PatternMatcher().scan(project_root)
    domain = DomainScanner().scan(project_root)

    suffix = path.suffix.lower()
    if suffix in (".ts", ".js"):
        framework = "playwright"
    elif suffix == ".py":
        framework = "pytest"
    else:
        framework = "unknown"

    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        context_snippets = lines[:40]
    except OSError:
        context_snippets = []

    return {
        "framework": framework,
        "test_type": "e2e" if framework == "playwright" else "api",
        "imports": pattern.common_imports,
        "functions": domain.functions[:10],
        "existing_tests": [],
        "context_snippets": context_snippets,
    }


def _write_test_file_impl(file_path: str, content: str, framework: str) -> dict:
    path = Path(file_path)
    if not path.suffix:
        ext_map = {
            "playwright": ".spec.ts",
            "vitest": ".test.ts",
            "pytest": ".py",
            "k6": ".js",
        }
        path = path.with_suffix(ext_map.get(framework, ".ts"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"written_path": str(path)}


def _run_tests_impl(test_file: str) -> dict:
    path = Path(test_file)
    suffix = path.suffix.lower()
    framework = "pytest" if suffix == ".py" else "playwright"
    executor = OracleTestExecutor()
    try:
        exit_code, stdout, stderr = executor.execute(path, framework)
    except Exception as exc:
        return {"passed": 0, "failed": 0, "output": str(exc), "exit_code": 1}
    output = (stdout or "") + (stderr or "")
    passed = output.count(" passed") + (1 if exit_code == 0 else 0)
    failed = 0 if exit_code == 0 else 1
    return {
        "passed": passed,
        "failed": failed,
        "output": output,
        "exit_code": exit_code,
    }


def _init_suite_impl(framework: str, target_dir: str) -> dict:
    target = target_dir or _WORKING_DIR
    scaffolder = Scaffolder()
    result = scaffolder.scaffold(framework, project_root=target)
    return {
        "files_created": result["created_files"] + result["created_dirs"],
        "framework": framework,
    }


def _list_frameworks_impl() -> dict:
    registry = FrameworkRegistry()
    names = [f["name"] for f in registry.get_all_frameworks()]
    return {"frameworks": names}


def _migrate_impl(target_dir: str, apply: bool) -> dict:
    root = Path(target_dir or _WORKING_DIR)
    migrator = HarnessMigrator()
    ctx = migrator.detect(root)
    if not ctx.is_harness_project:
        return {"error": "no harness.config.json found"}
    report = migrator.migrate(root, dry_run=not apply)
    if report.dry_run:
        return {
            "framework": report.framework,
            "files_created": [],
            "files_skipped": [],
            "manual_followups": report.manual_followups,
            "dry_run": True,
        }
    return {
        "framework": report.framework,
        "files_created": report.created_files + report.created_dirs,
        "files_skipped": report.skipped_configs,
        "manual_followups": report.manual_followups,
        "dry_run": False,
    }


# ---------------------------------------------------------------------------
# MCP tool registrations
# ---------------------------------------------------------------------------

@mcp.tool()
def oracle__analyze_file(file_path: str) -> dict:
    """Analyse a source file and return everything needed to write a test."""
    return _analyze_file_impl(file_path)


@mcp.tool()
def oracle__write_test_file(file_path: str, content: str, framework: str) -> dict:
    """Write test content to file_path, creating parent directories as needed."""
    return _write_test_file_impl(file_path, content, framework)


@mcp.tool()
def oracle__run_tests(test_file: str) -> dict:
    """Run a test file and return exit code and output without raising."""
    return _run_tests_impl(test_file)


@mcp.tool()
def oracle__init_suite(framework: str, target_dir: str = "") -> dict:
    """Scaffold a test suite for framework in target_dir."""
    return _init_suite_impl(framework, target_dir)


@mcp.tool()
def oracle__list_frameworks() -> dict:
    """Return all frameworks registered in agent/frameworks/registry.json."""
    return _list_frameworks_impl()


@mcp.tool()
def oracle__migrate(target_dir: str = "", apply: bool = False) -> dict:
    """Migrate a harness-scaffolded project to Oracle layout. Dry-run by default."""
    return _migrate_impl(target_dir, apply)


if __name__ == "__main__":
    mcp.run()
