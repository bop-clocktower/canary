"""Unit tests for plugins/oracle/hooks/*.py hook scripts.

Each hook is exercised as a subprocess with crafted stdin payloads,
matching the Claude Code hook protocol (JSON in, exit code out).
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOKS_DIR = Path(__file__).parents[2] / "plugins" / "oracle" / "hooks"


def _run(hook: str, payload) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HOOKS_DIR / hook)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )


def _run_raw(hook: str, raw: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HOOKS_DIR / hook)],
        input=raw,
        capture_output=True,
        text=True,
    )


class TestBlockNoVerify(unittest.TestCase):
    def test_allows_normal_commit(self):
        r = _run("block-no-verify.py", {"tool_input": {"command": "git commit -m 'test'"}})
        self.assertEqual(r.returncode, 0)

    def test_blocks_no_verify_on_commit(self):
        r = _run("block-no-verify.py", {"tool_input": {"command": "git commit --no-verify -m test"}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("BLOCKED", r.stderr)

    def test_blocks_short_n_on_commit(self):
        r = _run("block-no-verify.py", {"tool_input": {"command": "git commit -n -m test"}})
        self.assertEqual(r.returncode, 2)

    def test_allows_push_with_no_verify(self):
        # --no-verify on non-commit commands must not be blocked
        r = _run("block-no-verify.py", {"tool_input": {"command": "git push --no-verify"}})
        self.assertEqual(r.returncode, 0)

    def test_malformed_json_is_fail_open(self):
        self.assertEqual(_run_raw("block-no-verify.py", "not json").returncode, 0)

    def test_empty_stdin_is_fail_open(self):
        self.assertEqual(_run_raw("block-no-verify.py", "").returncode, 0)


class TestProtectConfig(unittest.TestCase):
    def test_allows_normal_python_file(self):
        r = _run("protect-config.py", {"tool_input": {"file_path": "agent/core/orchestrator.py"}})
        self.assertEqual(r.returncode, 0)

    def test_blocks_pyproject_toml(self):
        r = _run("protect-config.py", {"tool_input": {"file_path": "/repo/pyproject.toml"}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("BLOCKED", r.stderr)

    def test_blocks_ruff_toml(self):
        r = _run("protect-config.py", {"tool_input": {"file_path": "ruff.toml"}})
        self.assertEqual(r.returncode, 2)

    def test_blocks_setup_cfg(self):
        r = _run("protect-config.py", {"tool_input": {"file_path": "setup.cfg"}})
        self.assertEqual(r.returncode, 2)

    def test_path_traversal_is_still_blocked(self):
        r = _run("protect-config.py", {"tool_input": {"file_path": "../../pyproject.toml"}})
        self.assertEqual(r.returncode, 2)

    def test_malformed_json_is_fail_open(self):
        self.assertEqual(_run_raw("protect-config.py", "bad").returncode, 0)


class TestQualityGate(unittest.TestCase):
    def test_non_python_file_skipped(self):
        r = _run("quality-gate.py", {"tool_input": {"file_path": "README.md"}})
        self.assertEqual(r.returncode, 0)

    def test_empty_payload_exits_zero(self):
        self.assertEqual(_run("quality-gate.py", {}).returncode, 0)

    def test_nonexistent_py_file_exits_zero(self):
        r = _run("quality-gate.py", {"tool_input": {"file_path": "/nonexistent/missing.py"}})
        self.assertEqual(r.returncode, 0)

    def test_malformed_json_is_fail_open(self):
        self.assertEqual(_run_raw("quality-gate.py", "bad json").returncode, 0)


class TestPreCompactState(unittest.TestCase):
    def test_valid_payload_exits_zero(self):
        r = _run("pre-compact-state.py", {"session_id": "test-123"})
        self.assertEqual(r.returncode, 0)

    def test_empty_stdin_is_fail_open(self):
        r = _run_raw("pre-compact-state.py", "")
        self.assertEqual(r.returncode, 0)
        self.assertIn("fail-open", r.stderr)

    def test_malformed_json_is_fail_open(self):
        r = _run_raw("pre-compact-state.py", "bad")
        self.assertEqual(r.returncode, 0)
        self.assertIn("fail-open", r.stderr)


if __name__ == "__main__":
    unittest.main()
