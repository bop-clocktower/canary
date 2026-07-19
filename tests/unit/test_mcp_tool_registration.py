"""Regression: the registered @mcp.tool() wrappers and the canary__ namespace.

Gap 2 of issue #310 (harness↔canary MCP seam). The existing MCP suite exercises
the `_impl` functions directly, which never proves the thin `@mcp.tool()`
wrappers are wired to them. Two guarantees are characterized here:

1. **Wiring.** Every registered tool wrapper (`canary__analyze_file`, …) must
   delegate to its `_impl`. A wrapper that silently returned `{}` — or called
   the wrong impl — would pass every `_impl`-level test yet break the live MCP
   surface Claude Code actually calls.

2. **Namespace isolation.** Canary and the harness expose their tools into the
   *same* MCP namespace inside a session. Every canary tool must carry the
   `canary__` prefix so it can never collide with a harness tool name. This
   test reloads the server against a recording registry to capture the true
   set of registered tools, then asserts the prefix invariant over all of them.
"""

from __future__ import annotations

import importlib
import sys
import unittest
from unittest.mock import MagicMock, patch


def _load_server_with_recording_registry():
    """Reimport agent.mcp_server with a FastMCP mock that records every
    function passed to @mcp.tool(). Returns (module, {name: func})."""
    registered: dict[str, object] = {}

    def tool_factory(*_a, **_k):
        def decorator(fn):
            registered[fn.__name__] = fn
            return fn
        return decorator

    fake_instance = MagicMock()
    fake_instance.tool = tool_factory
    fake_module = MagicMock()
    fake_module.FastMCP = MagicMock(return_value=fake_instance)

    saved = sys.modules.get("fastmcp")
    sys.modules["fastmcp"] = fake_module
    try:
        import agent.mcp_server as srv
        srv = importlib.reload(srv)
    finally:
        # Restore a plain identity-decorator mock so sibling tests that rely on
        # the module keep the module-level _impl/wrapper functions intact.
        restore = MagicMock()
        restore.FastMCP.return_value.tool.return_value = lambda f: f
        sys.modules["fastmcp"] = saved if saved is not None else restore
    return srv, registered


# Representative harness MCP tool names (bare, no canary__ prefix). The canary__
# prefix invariant makes a name-for-name collision with any of these impossible.
_HARNESS_TOOL_NAMES = {
    "run_ci_checks", "acceptance_eval", "outcome_eval", "review_changes",
    "run_skill", "search_skills", "manage_roadmap", "detect_drift",
    "code_search", "ask_graph", "run_security_scan", "check_docs",
}

_EXPECTED_TOOLS = {
    "canary__analyze_file",
    "canary__write_test_file",
    "canary__run_tests",
    "canary__init_suite",
    "canary__list_frameworks",
    "canary__migrate",
}


class TestToolRegistration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.srv, cls.registered = _load_server_with_recording_registry()

    def test_all_six_tools_registered(self):
        self.assertEqual(set(self.registered), _EXPECTED_TOOLS)

    def test_every_registered_tool_has_canary_prefix(self):
        """The load-bearing namespace invariant."""
        self.assertTrue(self.registered, "no tools were registered")
        for name in self.registered:
            self.assertTrue(
                name.startswith("canary__"),
                f"registered MCP tool {name!r} lacks the canary__ prefix",
            )

    def test_no_registered_tool_collides_with_a_harness_tool_name(self):
        collisions = set(self.registered) & _HARNESS_TOOL_NAMES
        self.assertEqual(collisions, set(), f"name collision with harness: {collisions}")

    def test_prefix_guarantees_disjoint_namespace(self):
        """No canary tool name (canary__*) can equal a bare harness tool name."""
        for name in self.registered:
            self.assertNotIn(name, _HARNESS_TOOL_NAMES)


class TestWrappersDelegateToImpl(unittest.TestCase):
    """Each wrapper must actually call its _impl — not the impl called directly."""

    @classmethod
    def setUpClass(cls):
        cls.srv, cls.registered = _load_server_with_recording_registry()

    def test_list_frameworks_wrapper_delegates(self):
        sentinel = {"frameworks": ["sentinel-fw"]}
        with patch.object(self.srv, "_list_frameworks_impl", return_value=sentinel) as m:
            out = self.registered["canary__list_frameworks"]()
        m.assert_called_once_with()
        self.assertIs(out, sentinel)

    def test_analyze_file_wrapper_delegates_with_arg(self):
        sentinel = {"framework": "sentinel"}
        with patch.object(self.srv, "_analyze_file_impl", return_value=sentinel) as m:
            out = self.registered["canary__analyze_file"]("/some/path.ts")
        m.assert_called_once_with("/some/path.ts")
        self.assertIs(out, sentinel)

    def test_write_test_file_wrapper_forwards_all_args(self):
        sentinel = {"written_path": "/x"}
        with patch.object(self.srv, "_write_test_file_impl", return_value=sentinel) as m:
            out = self.registered["canary__write_test_file"]("/x", "body", "pytest")
        m.assert_called_once_with("/x", "body", "pytest")
        self.assertIs(out, sentinel)

    def test_run_tests_wrapper_delegates(self):
        sentinel = {"exit_code": 0}
        with patch.object(self.srv, "_run_tests_impl", return_value=sentinel) as m:
            out = self.registered["canary__run_tests"]("/t/test_x.py")
        m.assert_called_once_with("/t/test_x.py")
        self.assertIs(out, sentinel)

    def test_init_suite_wrapper_delegates(self):
        sentinel = {"framework": "playwright"}
        with patch.object(self.srv, "_init_suite_impl", return_value=sentinel) as m:
            out = self.registered["canary__init_suite"]("playwright", "/dir")
        m.assert_called_once_with("playwright", "/dir")
        self.assertIs(out, sentinel)

    def test_migrate_wrapper_delegates(self):
        sentinel = {"dry_run": True}
        with patch.object(self.srv, "_migrate_impl", return_value=sentinel) as m:
            out = self.registered["canary__migrate"]("/dir", True)
        m.assert_called_once_with("/dir", True)
        self.assertIs(out, sentinel)


if __name__ == "__main__":
    unittest.main()
