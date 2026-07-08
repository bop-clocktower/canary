"""Regression tests: Sentinel injection scan is scoped to UNTRUSTED sources.

The prompt-injection scan (sentinel-pre input scan + sentinel-post output scan)
should only taint on content from genuinely untrusted sources (WebFetch/
WebSearch and third-party MCP tools). Reading/writing/running local repo tools
(Read/Grep/Glob/Edit/Write/Bash + first-party MCP) must NOT taint — that was the
false-positive source that gated normal feature work.

Injection is triggered with a zero-width space (U+200B → rule INJ-UNI-001) so
the test needs no security-phrase literal (which would itself leak / self-taint).
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_HOOKS = _REPO / ".harness" / "hooks"
_ZW = chr(0x200B)  # zero-width space — deterministic INJ-UNI-001 (high) trigger

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node required to exercise the JS hooks"
)


def _run(hook: str, payload: dict, cwd: Path) -> None:
    subprocess.run(
        ["node", str(_HOOKS / hook)],
        input=json.dumps(payload),
        text=True,
        cwd=str(cwd),
        capture_output=True,
    )


def _tainted(cwd: Path) -> bool:
    d = cwd / ".harness"
    return bool(list(d.glob("session-taint-*.json"))) if d.exists() else False


# --- sentinel-post.js (tool-output scan) -----------------------------------

def test_post_trusted_read_output_does_not_taint(tmp_path):
    _run("sentinel-post.js",
         {"tool_name": "Read", "tool_output": f"x{_ZW}y", "session_id": "T"}, tmp_path)
    assert not _tainted(tmp_path), "reading a local file must not taint"


def test_post_trusted_bash_output_does_not_taint(tmp_path):
    _run("sentinel-post.js",
         {"tool_name": "Bash", "tool_output": f"commit{_ZW}msg", "session_id": "T"}, tmp_path)
    assert not _tainted(tmp_path), "local shell output must not taint"


def test_post_untrusted_webfetch_output_taints(tmp_path):
    _run("sentinel-post.js",
         {"tool_name": "WebFetch", "tool_output": f"x{_ZW}y", "session_id": "T"}, tmp_path)
    assert _tainted(tmp_path), "untrusted web content injection must still taint"


def test_post_untrusted_thirdparty_mcp_output_taints(tmp_path):
    _run("sentinel-post.js",
         {"tool_name": "mcp__plugin_github_github__get_me",
          "tool_output": f"x{_ZW}y", "session_id": "T"}, tmp_path)
    assert _tainted(tmp_path), "third-party MCP result injection must still taint"


# --- sentinel-pre.js (tool-input scan) -------------------------------------

def test_pre_trusted_write_input_does_not_taint(tmp_path):
    _run("sentinel-pre.js",
         {"tool_name": "Write",
          "tool_input": {"file_path": str(tmp_path / "f.txt"), "content": f"a{_ZW}b"},
          "session_id": "T"}, tmp_path)
    assert not _tainted(tmp_path), "writing local content must not taint"


def test_pre_untrusted_mcp_input_taints(tmp_path):
    _run("sentinel-pre.js",
         {"tool_name": "mcp__plugin_github_github__get_me",
          "tool_input": {"query": f"a{_ZW}b"}, "session_id": "T"}, tmp_path)
    assert _tainted(tmp_path), "third-party MCP input injection must still taint"


# --- first-party MCP is trusted -------------------------------------------

def test_post_first_party_mcp_output_does_not_taint(tmp_path):
    _run("sentinel-post.js",
         {"tool_name": "mcp__harness__run_skill",
          "tool_output": f"x{_ZW}y", "session_id": "T"}, tmp_path)
    assert not _tainted(tmp_path), "first-party harness MCP must not taint"
