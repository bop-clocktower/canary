"""Unit tests for hooks/*.py hook scripts.

Each hook is exercised as a subprocess with crafted stdin payloads,
matching the Claude Code hook protocol (JSON in, exit code out).

Hooks run in an isolated temp cwd by default so their harness-dedup guard
(``_harness_dedup.harness_hook_present``, which probes ``<cwd>/.harness/hooks``)
sees no harness counterpart and executes its real logic. The dedup tests opt in
by materializing a fake ``.harness/hooks/<name>.js`` in the cwd.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOKS_DIR = Path(__file__).parents[2] / "hooks"

# Import the shared dedup helper directly for unit-level assertions.
sys.path.insert(0, str(HOOKS_DIR))
import _harness_dedup  # noqa: E402


def _exec(hook: str, raw: str, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HOOKS_DIR / hook)],
        input=raw,
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def _run(hook: str, payload, cwd: str | None = None) -> subprocess.CompletedProcess:
    if cwd is None:
        with tempfile.TemporaryDirectory() as tmp:
            return _exec(hook, json.dumps(payload), tmp)
    return _exec(hook, json.dumps(payload), cwd)


def _run_raw(hook: str, raw: str, cwd: str | None = None) -> subprocess.CompletedProcess:
    if cwd is None:
        with tempfile.TemporaryDirectory() as tmp:
            return _exec(hook, raw, tmp)
    return _exec(hook, raw, cwd)


def _wire_harness_hook(root: Path, js_basename: str) -> None:
    """Create a stand-in harness hook so the dedup guard treats it as present."""
    hooks_dir = root / ".harness" / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    (hooks_dir / js_basename).write_text("// stub\n", encoding="utf-8")


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

    def test_defers_when_harness_hook_present(self):
        # With harness's block-no-verify.js wired, canary must not double-block.
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "block-no-verify.js")
            r = _run(
                "block-no-verify.py",
                {"tool_input": {"command": "git commit --no-verify -m test"}},
                cwd=tmp,
            )
        self.assertEqual(r.returncode, 0)


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

    def test_cedes_ruff_toml_when_harness_present(self):
        # harness protect-config.js already guards ruff.toml — don't double-block.
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "protect-config.js")
            r = _run("protect-config.py", {"tool_input": {"file_path": "ruff.toml"}}, cwd=tmp)
        self.assertEqual(r.returncode, 0)

    def test_keeps_python_config_when_harness_present(self):
        # pyproject.toml is Python-unique — canary keeps protecting it even when
        # harness is wired (harness's JS hook does not cover it).
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "protect-config.js")
            r = _run("protect-config.py", {"tool_input": {"file_path": "pyproject.toml"}}, cwd=tmp)
        self.assertEqual(r.returncode, 2)


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

    def test_defers_when_harness_present_and_ruff_config_present(self):
        # When a standalone ruff config exists AND harness quality-warner.js is
        # wired, format-check.js runs ruff — canary defers to avoid double-ruff.
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "quality-warner.js")
            (Path(tmp) / "ruff.toml").write_text("", encoding="utf-8")
            r = _run("quality-gate.py", {"tool_input": {"file_path": "x.py"}}, cwd=tmp)
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("[quality-gate]", r.stderr)

    def test_runs_when_harness_present_but_no_standalone_ruff_config(self):
        # ruff configured in pyproject.toml (no ruff.toml) → format-check.js sees
        # no formatter, so canary's per-file ruff must keep running (not defer).
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "quality-warner.js")
            # A non-python target still exits 0, but must go through the hook's
            # own logic rather than the dedup short-circuit.
            r = _run("quality-gate.py", {"tool_input": {"file_path": "README.md"}}, cwd=tmp)
        self.assertEqual(r.returncode, 0)


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

    def test_defers_when_harness_hook_present(self):
        # harness's pre-compact-state.js writes the same summary file — defer so
        # only one writer runs and no summary is written by the Python hook.
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "pre-compact-state.js")
            r = _run("pre-compact-state.py", {"session_id": "abc"}, cwd=tmp)
            self.assertEqual(r.returncode, 0)
            self.assertNotIn("Saved pre-compact summary", r.stderr)
            self.assertFalse(
                (Path(tmp) / ".harness" / "state" / "pre-compact-summary.json").exists()
            )


class TestHarnessDedupHelper(unittest.TestCase):
    def test_harness_hook_present_true_when_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            _wire_harness_hook(Path(tmp), "block-no-verify.js")
            self.assertTrue(
                _harness_dedup.harness_hook_present("block-no-verify.js", cwd=tmp)
            )

    def test_harness_hook_present_false_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(
                _harness_dedup.harness_hook_present("block-no-verify.js", cwd=tmp)
            )

    def test_ruff_config_present_detects_both_names(self):
        for name in (".ruff.toml", "ruff.toml"):
            with tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / name).write_text("", encoding="utf-8")
                self.assertTrue(_harness_dedup.ruff_config_present(cwd=tmp))

    def test_ruff_config_absent_when_only_pyproject(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").write_text("[tool.ruff]\n", encoding="utf-8")
            self.assertFalse(_harness_dedup.ruff_config_present(cwd=tmp))


if __name__ == "__main__":
    unittest.main()
