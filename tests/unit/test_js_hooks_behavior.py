"""Node-gated behavioral tests for the .harness/hooks/*.js quality/routing hooks.

Gap 5 of issue #310 (harness↔canary hook seam). These hooks are shipped JS that
CI's Python suite never exercised, so their exit-code policy could silently rot.
Following the node-gated pattern of test_sentinel_source_scope.py (skip when node
is absent) we drive the real hook scripts as subprocesses and assert:

  * ``quality-warner.js`` / ``format-check.js`` — exit 0 on a clean file and on
    a project with no formatter (fail-open), exit 2 on a real lint violation,
    and exit 0 on empty stdin (fail-open);
  * ``prefer-first-party-mcp.js`` — injects the routing reminder for a
    third-party MCP tool but stays silent for first-party prefixes, including
    ``mcp__canary-mcp__`` which it now trusts per #309.

Written as unittest.TestCase so they run under both ``pytest`` and CI's
``python -m unittest discover``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_HOOKS = _REPO / ".harness" / "hooks"

_HAVE_NODE = shutil.which("node") is not None
_HAVE_RUFF = shutil.which("ruff") is not None


def _run_hook(hook: str, payload: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(_HOOKS / hook)],
        input=json.dumps(payload),
        text=True,
        cwd=str(cwd),
        capture_output=True,
    )


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestQualityWarnerExitCodes(unittest.TestCase):
    """quality-warner.js wraps format-check.js; its exit code is the policy."""

    def _project(self, files: dict[str, str]) -> Path:
        tmp = tempfile.mkdtemp()
        root = Path(tmp)
        for name, content in files.items():
            (root / name).write_text(content, encoding="utf-8")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return root

    def test_no_formatter_config_fails_open(self):
        """No detectable formatter → 'clean' → exit 0 (never wall off an edit)."""
        root = self._project({"whatever.py": "x = 1\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "whatever.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 0)

    def test_empty_stdin_fails_open(self):
        root = self._project({})
        cp = subprocess.run(
            ["node", str(_HOOKS / "quality-warner.js")],
            input="",
            text=True,
            cwd=str(root),
            capture_output=True,
        )
        self.assertEqual(cp.returncode, 0)

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_clean_file_with_ruff_passes(self):
        root = self._project({"ruff.toml": "line-length = 100\n", "clean.py": "x = 1\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "clean.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 0, cp.stderr)

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_violating_file_blocks_with_exit_2(self):
        # F401: unused import — a deterministic ruff violation.
        root = self._project({"ruff.toml": "line-length = 100\n", "bad.py": "import os\n"})
        cp = _run_hook(
            "quality-warner.js",
            {"tool_input": {"file_path": str(root / "bad.py")}},
            root,
        )
        self.assertEqual(cp.returncode, 2, cp.stdout + cp.stderr)
        self.assertIn("BLOCKED", cp.stderr)


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestFormatCheckStatusContract(unittest.TestCase):
    """Directly exercise format-check.js's status classification (the core)."""

    def _driver(self) -> tuple[Path, Path]:
        tmp = tempfile.mkdtemp()
        root = Path(tmp)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        fc_url = (_HOOKS / "format-check.js").as_uri()
        driver = root / "driver.mjs"
        driver.write_text(
            f"import {{ runFormatCheck }} from {json.dumps(fc_url)};\n"
            "const input = JSON.parse(process.argv[2]);\n"
            "const res = runFormatCheck(input, process.argv[3]);\n"
            "process.stdout.write(res.status);\n",
            encoding="utf-8",
        )
        return root, driver

    def _status(self, driver: Path, payload: dict, cwd: Path) -> str:
        cp = subprocess.run(
            ["node", str(driver), json.dumps(payload), str(cwd)],
            text=True,
            capture_output=True,
        )
        return cp.stdout.strip()

    def test_no_formatter_returns_clean(self):
        root, driver = self._driver()
        (root / "f.py").write_text("x = 1\n", encoding="utf-8")
        status = self._status(driver, {"tool_input": {"file_path": str(root / "f.py")}}, root)
        self.assertEqual(status, "clean")

    @unittest.skipUnless(_HAVE_RUFF, "ruff required to trigger a real violation")
    def test_ruff_violation_returns_violations(self):
        root, driver = self._driver()
        (root / "ruff.toml").write_text("line-length = 100\n", encoding="utf-8")
        (root / "bad.py").write_text("import os\n", encoding="utf-8")
        status = self._status(driver, {"tool_input": {"file_path": str(root / "bad.py")}}, root)
        self.assertEqual(status, "violations")


@unittest.skipUnless(_HAVE_NODE, "node required to exercise the JS hooks")
class TestPreferFirstPartyMcp(unittest.TestCase):
    """The routing nudge fires for third-party MCP, stays silent for first-party."""

    def _out(self, tool_name: str) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            return _run_hook("prefer-first-party-mcp.js", {"tool_name": tool_name}, Path(tmp))

    def test_third_party_mcp_gets_reminder(self):
        cp = self._out("mcp__plugin_github_github__get_me")
        self.assertEqual(cp.returncode, 0)
        self.assertIn("Trusted MCP hierarchy", cp.stdout)

    def test_canary_mcp_prefix_is_trusted_silent(self):
        """#309: mcp__canary-mcp__* is first-party — no reminder."""
        cp = self._out("mcp__canary-mcp__analyze_file")
        self.assertEqual(cp.returncode, 0)
        self.assertEqual(cp.stdout.strip(), "")

    def test_harness_prefix_is_trusted_silent(self):
        cp = self._out("mcp__harness__run_skill")
        self.assertEqual(cp.stdout.strip(), "")

    def test_canary_bundle_prefix_is_trusted_silent(self):
        cp = self._out("mcp__plugin_mcp-bundle_context7__query_docs")
        self.assertEqual(cp.stdout.strip(), "")

    def test_non_mcp_tool_is_silent(self):
        cp = self._out("Read")
        self.assertEqual(cp.stdout.strip(), "")

    def test_another_third_party_bundle_gets_reminder(self):
        cp = self._out("mcp__plugin_github_github__search_code")
        self.assertIn("Trusted MCP hierarchy", cp.stdout)


if __name__ == "__main__":
    unittest.main()
