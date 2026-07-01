# Plan: Oracle Claude Code Plugin

**Date:** 2026-05-19 | **Spec:** docs/specs/oracle-plugin.md |
**Tasks:** 14 | **Time:** ~50 min | **Integration Tier:** large

---

## Goal

Expose Oracle's analysis and execution capabilities as a Claude Code plugin: an
MCP server (`agent/mcp_server.py`) with six tools, a plugin manifest, three
agent definitions, three skill files, and full unit-test coverage — all without
touching the existing CLI, GitHub Action, or IDE plugins.

---

## Observable Truths (Acceptance Criteria)

1. When `python -m agent.mcp_server` is executed, the process starts without
   error and registers six tools named `oracle__analyze_file`,
   `oracle__write_test_file`, `oracle__run_tests`, `oracle__init_suite`,
   `oracle__list_frameworks`, and `oracle__migrate`.
2. When `oracle__analyze_file` is called with a valid file path, the system
   shall return a dict containing keys `framework`, `test_type`, `imports`,
   `functions`, `existing_tests`, and `context_snippets`.
3. When `oracle__analyze_file` is called with a path that does not exist, the
   system shall return `{"error": "file not found: <path>"}`.
4. When `oracle__write_test_file` is called, the system shall create parent
   directories if absent and return `{"written_path": "<path>"}`.
5. When `oracle__run_tests` is called and the test runner exits non-zero, the
   system shall return `{"exit_code": 1, ...}` without raising a Python
   exception.
6. When `oracle__list_frameworks` is called, the system shall return all
   framework names registered in `agent/frameworks/registry.json`
   (currently `["playwright", "vitest", "pytest", "k6"]`).
7. When `oracle__init_suite` is called with a valid framework, the system shall
   return `{"files_created": [...], "framework": "<name>"}`.
8. When `oracle__migrate` is called with `apply=false`, the system shall return
   a plan dict with `dry_run: true` and no files written.
9. When `oracle__migrate` is called with `apply=true`, the system shall write
   scaffold files and return `{"dry_run": false, ...}`.
10. `python3 -m pytest tests/unit/test_mcp_server.py -v` passes all 10 tests
    with no real files written and no network calls.
11. `.claude-plugin/plugin.json` validates against the Claude Code plugin JSON
    Schema in CI (`validate-plugin-json` workflow step exits 0).
12. The existing CLI, GitHub Action, and IDE plugin workflows are unchanged
    (existing `pytest` runs continue to pass).

---

## Uncertainties

- [ASSUMPTION] FastMCP's `@mcp.tool()` decorator is the correct public API for
  registering tools; tool errors are surfaced by raising `Exception` inside the
  handler (FastMCP converts them to MCP error responses). If wrong, Task 2 will
  need revision of the error-return approach.
- [ASSUMPTION] `agent/core/` modules (`MetadataScanner`, `PatternMatcher`,
  `DomainScanner`, `CanaryTestExecutor`, `HarnessMigrator`, `FrameworkRegistry`,
  `Scaffolder`) are importable as-is from `agent.core.*` — verified by the
  existing test baseline (122 passing tests).
- [ASSUMPTION] The Claude Code plugin JSON Schema URL in the manifest
  (`https://raw.githubusercontent.com/anthropics/claude-code/main/schemas/plugin.schema.json`)
  is reachable from CI runners. The CI job uses `--no-download` validation
  against a vendored copy to avoid flakiness (see Task 12).
- [DEFERRABLE] The exact FastMCP version pinning in `pyproject.toml`. The plan
  uses `fastmcp>=2.0` as the minimum; adjust after confirming PyPI availability.
- [DEFERRABLE] Whether `CLAUDE_PLUGIN_ROOT` needs to be set for local testing.
  The MCP server falls back to `os.getcwd()` when unset.

---

## File Map

```text
CREATE agent/mcp_server.py
CREATE .claude-plugin/plugin.json
CREATE .claude-plugin/agents/oracle-test-generator.md
CREATE .claude-plugin/agents/oracle-initializer.md
CREATE .claude-plugin/agents/oracle-migrator.md
CREATE agents/skills/oracle:generate.md
CREATE agents/skills/oracle:init.md
CREATE agents/skills/oracle:migrate.md
CREATE tests/unit/test_mcp_server.py
CREATE .claude-plugin/schemas/plugin.schema.json
CREATE .github/workflows/validate-plugin.yml
MODIFY pyproject.toml  (add fastmcp dependency)
```

---

## Tasks

### Task 1: Add FastMCP dependency to pyproject.toml

**Depends on:** none | **Files:** `pyproject.toml`

1. Read `pyproject.toml`. The `[project]` `dependencies` list currently ends
   with `"rich>=13.7,<16"`. Add `"fastmcp>=2.0"` as a new entry:

   ```toml
   dependencies = [
       "anthropic>=0.102.0,<2",
       "google-genai>=2.3.0",
       "openai>=2.37.0,<3",
       "typer>=0.12,<1",
       "rich>=13.7,<16",
       "fastmcp>=2.0",
   ]
   ```

2. Install the new dependency so the remaining tasks can import it:

   ```bash
   pip install fastmcp
   ```

   Expected output: `Successfully installed fastmcp-<version> ...`

3. Verify import resolves:

   ```bash
   python3 -c "import fastmcp; print(fastmcp.__version__)"
   ```

   Expected: a version string printed without error.

4. Run `harness validate`.

5. Commit:

   ```text
   chore(deps): add fastmcp>=2.0 to pyproject.toml
   ```

---

### Task 2: Write failing tests for oracle__analyze_file and oracle__list_frameworks

**Depends on:** Task 1 | **Files:** `tests/unit/test_mcp_server.py`

1. Create `tests/unit/test_mcp_server.py` with the following content:

   ```python
   # tests/unit/test_mcp_server.py
   """Unit tests for agent/mcp_server.py — all I/O and intelligence calls mocked."""

   import importlib
   import sys
   from pathlib import Path
   from unittest.mock import MagicMock, patch, mock_open

   import pytest


   # ---------------------------------------------------------------------------
   # Helpers
   # ---------------------------------------------------------------------------

   def _reload_server():
       """Re-import mcp_server so module-level FastMCP wiring is fresh."""
       if "agent.mcp_server" in sys.modules:
           del sys.modules["agent.mcp_server"]
       return importlib.import_module("agent.mcp_server")


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
   ```

2. Run the tests and observe they fail (module not yet created):

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py -v 2>&1 | head -30
   ```

   Expected: `ModuleNotFoundError: No module named 'agent.mcp_server'` or
   `ImportError`.

3. Run `harness validate`.

4. Commit:

   ```text
   test(mcp): add failing tests for analyze_file and list_frameworks
   ```

---

### Task 3: Implement oracle__analyze_file and oracle__list_frameworks

**Depends on:** Task 2 | **Files:** `agent/mcp_server.py`

1. Create `agent/mcp_server.py` with the following content (only these two
   tool implementations for now; the remaining tools are stubs):

   ```python
   # agent/mcp_server.py
   """Oracle MCP server — exposes Oracle intelligence tools to Claude Code."""

   import os
   from pathlib import Path
   from typing import Any

   from fastmcp import FastMCP

   from agent.core.metadata_scanner import MetadataScanner
   from agent.core.pattern_matcher import PatternMatcher
   from agent.core.domain_scanner import DomainScanner
   from agent.core.executor import CanaryTestExecutor
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

       # Infer framework from file extension
       suffix = path.suffix.lower()
       if suffix in (".ts", ".js"):
           framework = "playwright"
       elif suffix == ".py":
           framework = "pytest"
       else:
           framework = "unknown"

       # Build context snippets from the source file (first 40 lines)
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
   ```

2. Run the two tests written in Task 2 and verify they pass:

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py::TestAnalyzeFile \
                     tests/unit/test_mcp_server.py::TestListFrameworks -v
   ```

   Expected output:

   ```text
   tests/unit/test_mcp_server.py::TestAnalyzeFile::test_analyze_file_returns_framework PASSED
   tests/unit/test_mcp_server.py::TestAnalyzeFile::test_analyze_file_missing_file PASSED
   tests/unit/test_mcp_server.py::TestListFrameworks::test_list_frameworks_returns_all PASSED
   3 passed
   ```

3. Run `harness validate`.

4. Commit:

   ```text
   feat(mcp): implement oracle MCP server with analyze_file and list_frameworks
   ```

---

### Task 4: Add tests for write_test_file and run_tests

**Depends on:** Task 3 | **Files:** `tests/unit/test_mcp_server.py`

1. Append the following two test classes to `tests/unit/test_mcp_server.py`
   (after the existing `TestListFrameworks` class):

   ```python
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
               "agent.core.executor.CanaryTestExecutor.execute",
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
               "agent.core.executor.CanaryTestExecutor.execute",
               return_value=(1, "", "AssertionError"),
           ):
               from agent import mcp_server as srv
               result = srv._run_tests_impl(str(test_file))

           assert result["exit_code"] == 1
           # Must not raise — result is a dict
           assert isinstance(result, dict)
   ```

2. Run the new tests and verify they pass (implementation is already in place
   from Task 3):

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py::TestWriteTestFile \
                     tests/unit/test_mcp_server.py::TestRunTests -v
   ```

   Expected: `2 passed` (or `4 passed` if both classes run).

3. Run `harness validate`.

4. Commit:

   ```text
   test(mcp): add tests for write_test_file and run_tests
   ```

---

### Task 5: Add tests for init_suite, migrate, and error

**Depends on:** Task 4 | **Files:** `tests/unit/test_mcp_server.py`

1. Append the following test classes to `tests/unit/test_mcp_server.py`:

   ```python
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
           # This must return a dict, not raise
           result = srv._analyze_file_impl("/does/not/exist.ts")
           assert isinstance(result, dict)
           assert "error" in result
   ```

2. Run all tests and confirm they pass (implementations already in place from
   Task 3):

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py -v
   ```

   Expected: `10 passed`.

3. Run `harness validate`.

4. Commit:

   ```text
   test(mcp): complete unit-test suite — 10 tests, all green
   ```

---

### Task 6: Create the plugin manifest

**Depends on:** Task 3 | **Files:** `.claude-plugin/plugin.json`

1. Create the directory (set `PLUGIN_ROOT` to your local plugin checkout, e.g.
   `PLUGIN_ROOT=~/path/to/canary-plugin`):

   ```bash
   mkdir -p "$PLUGIN_ROOT/.claude-plugin"
   ```

2. Create `.claude-plugin/plugin.json` with the following content exactly:

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/anthropics/claude-code/main/schemas/plugin.schema.json",
     "name": "oracle",
     "version": "1.0.0",
     "description": "AI-powered test generation for Claude Code — generate, init, and migrate test suites via slash commands.",
     "skills": ["./agents/skills"],
     "agents": "./.claude-plugin/agents/",
     "mcpServers": {
       "oracle": {
         "command": "python",
         "args": ["-m", "agent.mcp_server"],
         "cwd": "${CLAUDE_PLUGIN_ROOT}"
       }
     }
   }
   ```

3. Validate the JSON is well-formed:

   ```bash
   python3 -c "import json; json.load(open('.claude-plugin/plugin.json'))" && echo "JSON valid"
   ```

   Expected: `JSON valid`.

4. Run `harness validate`.

5. Commit:

   ```text
   feat(plugin): add .claude-plugin/plugin.json manifest
   ```

---

### Task 7: Create the three agent definition files

**Depends on:** Task 6 | **Files:** `.claude-plugin/agents/oracle-test-generator.md`,
`.claude-plugin/agents/oracle-initializer.md`,
`.claude-plugin/agents/oracle-migrator.md`

1. Create the directory:

   ```bash
   mkdir -p "$PLUGIN_ROOT/.claude-plugin/agents"
   ```

2. Create `.claude-plugin/agents/oracle-test-generator.md`:

   ```markdown
   ---
   name: oracle-test-generator
   description: Generates framework-appropriate tests for a source file using Oracle's MCP analysis tools.
   tools:
     - mcp__oracle__analyze_file
     - mcp__oracle__write_test_file
     - mcp__oracle__run_tests
     - Read
     - Bash
   ---

   # Oracle Test Generator

   You generate high-quality, runnable tests for a given source file by
   delegating analysis to Oracle's MCP tools and using the results to write
   targeted tests.

   ## Steps

   1. Call `oracle__analyze_file` with the target file path to obtain:
      - `framework` — the detected test framework
      - `imports` — existing import patterns in the project
      - `functions` — public functions in the source file
      - `context_snippets` — relevant source lines for reference

   2. Using the analysis output, generate test content that:
      - Matches the detected framework's conventions
      - Tests each public function identified in `functions`
      - Mirrors import style from `imports`
      - Derives expected behaviour from `context_snippets`

   3. Call `oracle__write_test_file` with the generated content and the
      resolved `framework`. Place the file under `tests/` adjacent to the
      source file, following the framework's naming convention
      (`*.spec.ts` for Playwright/Vitest, `test_*.py` for pytest).

   4. Call `oracle__run_tests` on the written file. Interpret the result:
      - `exit_code == 0` — report the passing test path to the user.
      - `exit_code != 0` — read `output`, revise the test content to fix
        the failure, and repeat from step 3 (up to 3 attempts total).

   5. After 3 failed attempts, report the last failure output verbatim and
      advise the user to run `oracle run <test_file>` manually.

   ## Constraints

   - Never modify the source file under test.
   - Preserve the project's existing assertion style from `context_snippets`.
   - Each attempt must produce a syntactically different test — do not
     retry with identical content.
   ```

3. Create `.claude-plugin/agents/oracle-initializer.md`:

   ```markdown
   ---
   name: oracle-initializer
   description: Scaffolds a new test suite for a chosen framework using Oracle's init tool.
   tools:
     - mcp__oracle__list_frameworks
     - mcp__oracle__init_suite
   ---

   # Oracle Initializer

   You bootstrap a test suite for the user's project by calling Oracle's
   scaffold tools.

   ## Steps

   1. If the user did not specify a framework, call `oracle__list_frameworks`
      to retrieve all supported options, then ask the user to choose one.

   2. Call `oracle__init_suite` with the chosen framework and an empty
      `target_dir` (defaults to the plugin root).

   3. Report the list of created files and directories from the response.
      Remind the user to install the framework's dependencies if applicable
      (e.g., `npm install --save-dev @playwright/test` for Playwright).

   ## Constraints

   - Do not call `oracle__init_suite` until a framework is confirmed.
   - If `oracle__init_suite` returns an error, surface the error message
     verbatim and suggest running `oracle init <framework>` from the CLI.
   ```

4. Create `.claude-plugin/agents/oracle-migrator.md`:

   ```markdown
   ---
   name: oracle-migrator
   description: Migrates a harness-scaffolded test suite to Oracle's layout with an explicit confirm-before-apply flow.
   tools:
     - mcp__oracle__migrate
     - Read
   ---

   # Oracle Migrator

   You migrate a harness test-suite project to Oracle's layout. Always
   show a dry-run plan before writing any files.

   ## Steps

   1. Call `oracle__migrate` with `apply=false` to produce a dry-run plan.

   2. Present the plan to the user:
      - `files_created` — files that will be written
      - `files_skipped` — existing files that will be preserved
      - `manual_followups` — actions the user must take after migration

   3. Ask the user to confirm: "Apply the migration? (yes/no)".
      Wait for an explicit "yes" before proceeding.

   4. On confirmation, call `oracle__migrate` with `apply=true`.

   5. Report the actual `files_created`, `files_skipped`, and
      `manual_followups` from the response.

   ## Constraints

   - Never call `oracle__migrate` with `apply=true` without an explicit
     user confirmation in step 3.
   - If the dry-run response contains `{"error": "no harness.config.json found"}`,
     inform the user that the current directory is not a harness project
     and stop.
   ```

5. Verify all three files are well-formed markdown:

   ```bash
   python3 -c "
   from pathlib import Path
   for f in [
       '.claude-plugin/agents/oracle-test-generator.md',
       '.claude-plugin/agents/oracle-initializer.md',
       '.claude-plugin/agents/oracle-migrator.md',
   ]:
       text = Path(f).read_text()
       assert '---' in text, f'{f} missing frontmatter'
       print(f'OK: {f}')
   "
   ```

   Expected: three `OK:` lines.

6. Run `harness validate`.

7. Commit:

   ```text
   feat(plugin): add three agent definition files
   ```

---

### Task 8: Create the three skill files

**Depends on:** Task 7 | **Files:** `agents/skills/oracle:generate.md`,
`agents/skills/oracle:init.md`, `agents/skills/oracle:migrate.md`

1. Create `agents/skills/oracle:generate.md`:

   ````markdown
   ---
   name: oracle:generate
   description: Generate a framework-appropriate test for the active editor file using Oracle's analysis pipeline.
   ---

   # oracle:generate

   Invoke the `oracle-test-generator` agent with the active editor file as
   the analysis target.

   ## Usage

   ```
   /oracle:generate [file_path]
   ```

   If `file_path` is omitted, use the currently open file in the editor.

   ## Prompt template for the agent

   Provide this context to `oracle-test-generator`:

   ```
   Target file: <file_path>

   Analysis instructions:
   1. Call oracle__analyze_file on the target file.
   2. Use the returned framework, imports, functions, and context_snippets
      to write tests that:
      - Cover every public function listed in `functions`
      - Mirror the import style from `imports`
      - Follow naming conventions inferred from `context_snippets`
      - Use the assertion style standard for the detected framework
        (e.g. `expect().toBe()` for Playwright/Vitest, `assert` for pytest)
   3. Write the test file adjacent to the source file, e.g.:
      - src/auth/login.ts  →  tests/auth/login.spec.ts
      - agent/core/util.py →  tests/unit/test_util.py
   4. Run the test file and fix failures (up to 3 attempts).
   5. Report the final test file path and pass/fail status.
   ```

   ## Success criteria

   - The generated test file exists at the expected path.
   - `oracle__run_tests` returns `exit_code == 0` on the final attempt.
   - If tests could not be made to pass after 3 attempts, the agent
     reports the last failure output and the test file path.
   ````

2. Create `agents/skills/oracle:init.md`:

   ````markdown
   ---
   name: oracle:init
   description: Scaffold a new test suite for a chosen framework using Oracle's initializer agent.
   ---

   # oracle:init

   Invoke the `oracle-initializer` agent to scaffold a test suite.

   ## Usage

   ```
   /oracle:init [framework]
   ```

   - If `[framework]` is provided (e.g. `/oracle:init playwright`), pass
     it directly to `oracle-initializer` — skip the framework-selection step.
   - If omitted, `oracle-initializer` will call `oracle__list_frameworks`
     and prompt the user to choose.

   ## Prompt template for the agent

   Provide this context to `oracle-initializer`:

   ```
   Framework: <framework or "unspecified">
   Target directory: <current working directory>

   If framework is "unspecified", call oracle__list_frameworks and ask the
   user to choose before calling oracle__init_suite.
   ```

   ## Success criteria

   - `oracle__init_suite` returns without error.
   - The response lists at least one created file or directory.
   - The user is reminded to install framework dependencies if applicable.
   ````

3. Create `agents/skills/oracle:migrate.md`:

   ````markdown
   ---
   name: oracle:migrate
   description: Migrate a harness-scaffolded test suite to Oracle's layout with a confirm-before-apply flow.
   ---

   # oracle:migrate

   Invoke the `oracle-migrator` agent against the current working directory.

   ## Usage

   ```
   /oracle:migrate
   ```

   The agent always runs a dry-run first and requires explicit confirmation
   before writing any files.

   ## Prompt template for the agent

   Provide this context to `oracle-migrator`:

   ```
   Target directory: <current working directory>

   1. Run oracle__migrate with apply=false and show the dry-run plan.
   2. Ask the user to confirm before applying.
   3. On confirmation, run oracle__migrate with apply=true.
   4. Report created files, skipped files, and manual follow-ups.
   ```

   ## Success criteria

   - Dry-run completes without error.
   - User explicitly confirmed before apply was called.
   - Final response lists all created files and required manual follow-ups.
   - If no harness project is detected, the agent surfaces the error and stops.
   ````

4. Verify all three skill files exist:

   ```bash
   python3 -c "
   from pathlib import Path
   for f in [
       'agents/skills/oracle:generate.md',
       'agents/skills/oracle:init.md',
       'agents/skills/oracle:migrate.md',
   ]:
       assert Path(f).exists(), f'missing: {f}'
       print(f'OK: {f}')
   "
   ```

   Expected: three `OK:` lines.

5. Run `harness validate`.

6. Commit:

   ```text
   feat(plugin): add oracle:generate, oracle:init, oracle:migrate skill files
   ```

---

### Task 9: Vendor the plugin JSON Schema for offline CI validation

**Depends on:** Task 6 | **Files:** `.claude-plugin/schemas/plugin.schema.json`

1. Create the schemas directory:

   ```bash
   mkdir -p "$PLUGIN_ROOT/.claude-plugin/schemas"
   ```

2. Create `.claude-plugin/schemas/plugin.schema.json` with a minimal but
   accurate JSON Schema that validates all required manifest fields:

   ```json
   {
     "$schema": "http://json-schema.org/draft-07/schema#",
     "title": "Claude Code Plugin Manifest",
     "type": "object",
     "required": ["name", "version", "description", "mcpServers"],
     "properties": {
       "$schema":     { "type": "string" },
       "name":        { "type": "string", "minLength": 1 },
       "version":     { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
       "description": { "type": "string", "minLength": 1 },
       "skills":      { "type": "array",  "items": { "type": "string" } },
       "agents":      { "type": "string" },
       "mcpServers": {
         "type": "object",
         "minProperties": 1,
         "additionalProperties": {
           "type": "object",
           "required": ["command", "args"],
           "properties": {
             "command": { "type": "string" },
             "args":    { "type": "array", "items": { "type": "string" } },
             "cwd":     { "type": "string" }
           }
         }
       }
     },
     "additionalProperties": true
   }
   ```

3. Verify the schema validates the plugin manifest using Python's `jsonschema`
   package (install if needed: `pip install jsonschema`):

   ```bash
   python3 -c "
   import json, jsonschema
   schema  = json.load(open('.claude-plugin/schemas/plugin.schema.json'))
   manifest = json.load(open('.claude-plugin/plugin.json'))
   jsonschema.validate(manifest, schema)
   print('Manifest is valid against schema')
   "
   ```

   Expected: `Manifest is valid against schema`.

4. Run `harness validate`.

5. Commit:

   ```text
   feat(plugin): vendor plugin JSON Schema for offline CI validation
   ```

---

### Task 10: Add CI workflow for plugin.json validation

**Depends on:** Task 9 | **Files:** `.github/workflows/validate-plugin.yml`

1. Create `.github/workflows/validate-plugin.yml`:

   ```yaml
   name: Validate Plugin Manifest

   on:
     push:
       branches: [main]
       paths:
         - '.claude-plugin/plugin.json'
         - '.claude-plugin/schemas/plugin.schema.json'
         - '.github/workflows/validate-plugin.yml'
     pull_request:
       branches: [main]
       paths:
         - '.claude-plugin/plugin.json'
         - '.claude-plugin/schemas/plugin.schema.json'
         - '.github/workflows/validate-plugin.yml'

   jobs:
     validate:
       name: Validate plugin.json against schema
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4

         - name: Set up Python
           uses: actions/setup-python@v5
           with:
             python-version: '3.11'

         - name: Install jsonschema
           run: pip install jsonschema==4.23.0

         - name: Validate plugin manifest
           run: |
             python3 - <<'EOF'
             import json, jsonschema, sys
             schema   = json.load(open('.claude-plugin/schemas/plugin.schema.json'))
             manifest = json.load(open('.claude-plugin/plugin.json'))
             try:
                 jsonschema.validate(manifest, schema)
                 print("plugin.json is valid")
             except jsonschema.ValidationError as e:
                 print(f"Validation FAILED: {e.message}", file=sys.stderr)
                 sys.exit(1)
             EOF
   ```

2. Verify the YAML is syntactically valid:

   ```bash
   python3 -c "import yaml; yaml.safe_load(open('.github/workflows/validate-plugin.yml'))" && echo "YAML valid"
   ```

   Expected: `YAML valid`.

   > Note: this requires `pip install pyyaml` if not already installed.

3. Run `harness validate`.

4. Commit:

   ```text
   ci: add validate-plugin.yml — JSON Schema validation of plugin manifest
   ```

---

### Task 11: Full integration smoke test — MCP server starts

**Depends on:** Tasks 3, 6 | **Files:** none (verification only)

[checkpoint:human-verify]

1. Start the MCP server as Claude Code would:

   ```bash
   cd "$PLUGIN_ROOT"
   timeout 5 python3 -m agent.mcp_server 2>&1 || true
   ```

   Expected: server starts and prints something like:

   ```text
   Starting Oracle MCP server...
   ```

   or exits cleanly when stdin closes (timeout exit). No `ImportError` or
   `ModuleNotFoundError` should appear.

2. Verify the six tools are registered by inspecting the server source:

   ```bash
   python3 -c "
   import agent.mcp_server as s
   tools = [f.__name__ for f in [
       s.oracle__analyze_file,
       s.oracle__write_test_file,
       s.oracle__run_tests,
       s.oracle__init_suite,
       s.oracle__list_frameworks,
       s.oracle__migrate,
   ]]
   print('Registered tools:', tools)
   assert len(tools) == 6
   print('All 6 tools present')
   "
   ```

   Expected:

   ```text
   Registered tools: ['oracle__analyze_file', 'oracle__write_test_file', ...]
   All 6 tools present
   ```

3. Confirm the full unit-test suite is still green:

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py -v
   ```

   Expected: `10 passed`.

4. Run `harness validate`.

5. If anything is unexpected, fix `agent/mcp_server.py` before proceeding.

---

### Task 12: Run full regression — confirm no existing tests broken

**Depends on:** Task 11 | **Files:** none (verification only)

1. Run the full unit-test suite excluding the three known-broken test files
   (pre-existing issues unrelated to this feature):

   ```bash
   python3 -m pytest tests/unit/ \
     --ignore=tests/unit/test_orchestrator.py \
     --ignore=tests/unit/test_selector_healer.py \
     --ignore=tests/unit/test_setup.py \
     -q --no-header
   ```

   Expected: `132 passed` (the original 122 + 10 new).

2. If any previously-passing test now fails, diagnose and fix the regression
   before continuing. Do not modify the pre-existing broken tests.

3. Run `harness validate`.

4. Commit any fixes needed:

   ```text
   fix(mcp): resolve regression in <test_name>
   ```

---

### Task 13: Update AGENTS.md — document new plugin capabilities

**Depends on:** Tasks 7, 8 | **Files:** `AGENTS.md` | **Category:** integration

1. Read `AGENTS.md`. Locate the section that describes the project's
   capabilities (search for "capabilities" or "features" headings).

2. Add an "Oracle Claude Code Plugin" subsection describing:
   - MCP server location: `agent/mcp_server.py`
   - Six exposed tools (list by name)
   - Plugin manifest: `.claude-plugin/plugin.json`
   - Three agents in `.claude-plugin/agents/`
   - Three skills: `/oracle:generate`, `/oracle:init`, `/oracle:migrate`
   - How to activate: load as a Claude Code plugin from the repo root

3. Verify `AGENTS.md` still parses (no broken markdown):

   ```bash
   python3 -c "
   from pathlib import Path
   text = Path('AGENTS.md').read_text()
   assert 'oracle:generate' in text
   assert 'mcp_server' in text
   print('AGENTS.md updated correctly')
   "
   ```

   Expected: `AGENTS.md updated correctly`.

4. Run `harness validate`.

5. Commit:

   ```text
   docs(agents): document Oracle Claude Code Plugin capabilities in AGENTS.md
   ```

---

### Task 14: Final validation pass

**Depends on:** Tasks 1–13 | **Files:** none

1. Run the complete plugin unit-test suite:

   ```bash
   python3 -m pytest tests/unit/test_mcp_server.py -v
   ```

   Expected: `10 passed`.

2. Run the full regression suite:

   ```bash
   python3 -m pytest tests/unit/ \
     --ignore=tests/unit/test_orchestrator.py \
     --ignore=tests/unit/test_selector_healer.py \
     --ignore=tests/unit/test_setup.py \
     -q --no-header
   ```

   Expected: `132 passed` (or more if fixes were added in Task 12).

3. Validate the plugin manifest against the vendored schema:

   ```bash
   python3 -c "
   import json, jsonschema
   schema   = json.load(open('.claude-plugin/schemas/plugin.schema.json'))
   manifest = json.load(open('.claude-plugin/plugin.json'))
   jsonschema.validate(manifest, schema)
   print('Manifest valid')
   "
   ```

   Expected: `Manifest valid`.

4. Verify all deliverable files exist:

   ```bash
   python3 -c "
   from pathlib import Path
   required = [
       'agent/mcp_server.py',
       '.claude-plugin/plugin.json',
       '.claude-plugin/agents/oracle-test-generator.md',
       '.claude-plugin/agents/oracle-initializer.md',
       '.claude-plugin/agents/oracle-migrator.md',
       'agents/skills/oracle:generate.md',
       'agents/skills/oracle:init.md',
       'agents/skills/oracle:migrate.md',
       'tests/unit/test_mcp_server.py',
       '.claude-plugin/schemas/plugin.schema.json',
       '.github/workflows/validate-plugin.yml',
   ]
   for f in required:
       p = Path(f)
       assert p.exists(), f'MISSING: {f}'
       print(f'OK: {f}')
   print(f'All {len(required)} files present')
   "
   ```

   Expected: all 11 paths print `OK:`.

5. Run `harness validate`.

6. Commit:

   ```text
   chore(plugin): final validation pass — all deliverables present and tests green
   ```

---

## Summary

| Task | What it delivers | Est. time |
| --- | --- | --- |
| 1 | `fastmcp` dependency in `pyproject.toml` | 2 min |
| 2 | Failing tests: `analyze_file`, `list_frameworks` | 3 min |
| 3 | `agent/mcp_server.py` — all 6 tools implemented | 5 min |
| 4 | Tests: `write_test_file`, `run_tests` | 3 min |
| 5 | Tests: `init_suite`, `migrate`, error case | 4 min |
| 6 | `.claude-plugin/plugin.json` manifest | 2 min |
| 7 | Three agent definition markdown files | 4 min |
| 8 | Three skill markdown files | 4 min |
| 9 | Vendored plugin JSON Schema | 3 min |
| 10 | CI workflow: `validate-plugin.yml` | 3 min |
| 11 | [checkpoint] MCP server smoke test | 4 min |
| 12 | Full regression — confirm no existing tests broken | 3 min |
| 13 | AGENTS.md integration documentation | 3 min |
| 14 | Final validation pass | 3 min |
| **Total** | | **~46 min** |

---

## Dependency Order

```text
Task 1 (pyproject)
  └── Task 2 (failing tests: analyze, list)
        └── Task 3 (mcp_server.py impl)
              ├── Task 4 (failing tests: write, run)
              │     └── Task 5 (failing tests: init, migrate, error)
              ├── Task 6 (plugin.json)
              │     ├── Task 7 (agents)
              │     │     ├── Task 8 (skills)
              │     │     └── Task 13 (AGENTS.md)
              │     └── Task 9 (schema)
              │           └── Task 10 (CI workflow)
              └── Task 11 (smoke test) ← needs Task 6
                    └── Task 12 (regression)
                          └── Task 14 (final pass)
```

Tasks 4+5, 6, and 9+10 are on independent branches after Task 3/Task 6 and
can be worked in parallel.
