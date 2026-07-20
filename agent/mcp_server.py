from __future__ import annotations

# agent/mcp_server.py
"""Canary MCP server — exposes Canary intelligence tools to Claude Code."""

import os
from pathlib import Path

from fastmcp import FastMCP

from agent.core.pattern_matcher import PatternMatcher
from agent.core.domain_scanner import DomainScanner
from agent.core.executor import CanaryTestExecutor
from agent.core.framework_registry import FrameworkRegistry
from agent.core.scaffolder import Scaffolder
from agent.core.migrator import HarnessMigrator

mcp = FastMCP("canary")

_WORKING_DIR = os.environ.get("CLAUDE_PLUGIN_ROOT", os.getcwd())


# ---------------------------------------------------------------------------
# Internal implementation functions (importable for unit tests without MCP)
# ---------------------------------------------------------------------------

_CONFIG_FRAMEWORK_GLOBS = (
    ("playwright", ("playwright.config.ts", "playwright.config.js",
                    "playwright.config.mts", "playwright.config.mjs")),
    ("vitest", ("vitest.config.ts", "vitest.config.js",
                "vitest.config.mts", "vitest.config.mjs")),
    ("pytest", ("pytest.ini", "pyproject.toml")),
)
_SUFFIX_FRAMEWORK = {
    ".ts": "playwright",
    ".tsx": "playwright",
    ".js": "playwright",
    ".jsx": "playwright",
    ".mjs": "playwright",
    ".py": "pytest",
}
# Cap test-file path list size to keep response payload reasonable.
_MAX_EXISTING_TESTS = 10
# Cap file-local function extraction so a giant file doesn't dominate.
_MAX_FILE_FUNCTIONS = 20


def _detect_framework_from_config(project_root: Path) -> tuple[str, str]:
    """Return (framework, source) where source indicates trust level.

    Walks up from project_root checking for canonical config files.
    `source` is one of: "config" (config file found),
    "suffix" (fell back to file extension), "unknown" (no signal).
    """
    cur = project_root.resolve()
    # Walk up to filesystem root or .git boundary.
    while True:
        for fw, globs in _CONFIG_FRAMEWORK_GLOBS:
            for name in globs:
                if (cur / name).exists():
                    if name == "pyproject.toml":
                        # Confirm it actually configures pytest.
                        try:
                            text = (cur / name).read_text(
                                encoding="utf-8", errors="ignore"
                            )
                            if "[tool.pytest" in text:
                                return fw, "config"
                            # Otherwise keep looking — pyproject alone is
                            # not enough to claim pytest.
                            continue
                        except OSError:
                            continue
                    return fw, "config"
        if (cur / ".git").exists():
            break
        if cur.parent == cur:
            break
        cur = cur.parent
    return "unknown", "unknown"


def _extract_file_functions(path: Path) -> list[str]:
    """Best-effort file-local function extraction.

    Python: AST-walks top-level + class-level def statements.
    TS/JS: regex-matches `function name(` and `const name = (` patterns.
    Falls back to empty list on parse failure.
    """
    suffix = path.suffix.lower()
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    names: list[str] = []
    if suffix == ".py":
        import ast
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                names.append(node.name)
    elif suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs"):
        import re
        # Conservative: only top-level-ish declarations.
        fn_re = re.compile(
            r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
            re.MULTILINE,
        )
        const_re = re.compile(
            r"^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(",
            re.MULTILINE,
        )
        names.extend(fn_re.findall(text))
        names.extend(const_re.findall(text))
    # Dedupe preserving order.
    seen: set[str] = set()
    deduped = []
    for n in names:
        if n not in seen:
            seen.add(n)
            deduped.append(n)
    return deduped[:_MAX_FILE_FUNCTIONS]


def _find_existing_tests(project_root: Path, framework: str) -> list[str]:
    """Return up to N existing test file paths relative to project_root.

    Uses PatternMatcher's discovery; falls back to a simple glob if the
    matcher returns nothing.
    """
    matcher = PatternMatcher()
    files = matcher._find_test_files(project_root, framework, "")
    if not files:
        return []
    out = []
    for f in files[:_MAX_EXISTING_TESTS]:
        try:
            out.append(str(f.relative_to(project_root)))
        except ValueError:
            out.append(str(f))
    return out


def _project_root_for(path: Path) -> Path:
    """Walk up from `path` to the nearest .git directory, else return parent.

    Matches the discovery convention used by `canary skills list` and the
    downstream overlay loader — the project boundary is the .git root.
    """
    cur = path.resolve().parent
    while True:
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            return path.parent.resolve()
        cur = cur.parent


def _analyze_file_impl(file_path: str) -> dict:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"file not found: {file_path}"}

    project_root = _project_root_for(path)
    pattern = PatternMatcher().scan(str(project_root))
    domain = DomainScanner().scan(str(project_root))

    # Framework detection: config files first, suffix as fallback.
    framework, framework_source = _detect_framework_from_config(project_root)
    if framework_source != "config":
        suffix_fw = _SUFFIX_FRAMEWORK.get(path.suffix.lower())
        if suffix_fw:
            framework = suffix_fw
            framework_source = "suffix"

    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        context_snippets = lines[:40]
    except OSError:
        context_snippets = []

    return {
        "framework": framework,
        "framework_source": framework_source,
        "test_type": "e2e" if framework == "playwright" else "api",
        "imports": pattern.common_imports,
        # `functions` historically returned project-wide public functions
        # from the DomainScanner. Kept for backward compat; agents should
        # prefer `file_functions` for the target file's own definitions.
        "functions": domain.functions[:10],
        "file_functions": _extract_file_functions(path),
        "existing_tests": _find_existing_tests(project_root, framework),
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
    executor = CanaryTestExecutor()
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
    # `frameworks` stays a name list for backward compatibility; `details`
    # additively exposes each framework's run-command (#357) so an MCP consumer
    # can use the registry as a framework → run-command source.
    return {"frameworks": names, "details": registry.summaries()}


def _migrate_impl(target_dir: str, apply: bool) -> dict:
    root = Path(target_dir or _WORKING_DIR)
    migrator = HarnessMigrator()
    ctx = migrator.detect(root)
    if not ctx.is_harness_project:
        # #319 C: distinguish "config present but not a test project" (e.g. a
        # skills/docs overlay) from a genuinely missing config.
        if ctx.not_test_project_reason:
            return {"error": ctx.not_test_project_reason}
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
def canary__analyze_file(file_path: str) -> dict:
    """Analyse a source file and return everything needed to write a test."""
    return _analyze_file_impl(file_path)


@mcp.tool()
def canary__write_test_file(file_path: str, content: str, framework: str) -> dict:
    """Write test content to file_path, creating parent directories as needed."""
    return _write_test_file_impl(file_path, content, framework)


@mcp.tool()
def canary__run_tests(test_file: str) -> dict:
    """Run a test file and return exit code and output without raising."""
    return _run_tests_impl(test_file)


@mcp.tool()
def canary__init_suite(framework: str, target_dir: str = "") -> dict:
    """Scaffold a test suite for framework in target_dir."""
    return _init_suite_impl(framework, target_dir)


@mcp.tool()
def canary__list_frameworks() -> dict:
    """Return all frameworks registered in agent/frameworks/registry.json."""
    return _list_frameworks_impl()


@mcp.tool()
def canary__migrate(target_dir: str = "", apply: bool = False) -> dict:
    """Migrate a harness-scaffolded project to Canary layout. Dry-run by default."""
    return _migrate_impl(target_dir, apply)


def main() -> None:
    """Console-script entry point for `canary-mcp` (see pyproject.toml).

    The Claude Code plugin manifest references this entry by name so it
    works against any pipx-installed canary-test-ai without depending on
    the source tree being checked out at ``${CLAUDE_PLUGIN_ROOT}``.
    """
    mcp.run()


if __name__ == "__main__":
    main()
