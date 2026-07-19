"""TDD for agent.guardian.pr_check — Tier 0 deterministic PR engine.

Phase 1 (agent-free). Covers diff scoping, findings, suppression, gate exit
codes, renderers, and the CLI wiring.
"""

from __future__ import annotations

from agent.guardian.coverage import ChangedUnit
from agent.guardian.pr_check import scope_diff


DIFF_TWO_FILES = """\
diff --git a/agent/core/foo.py b/agent/core/foo.py
index 1111111..2222222 100644
--- a/agent/core/foo.py
+++ b/agent/core/foo.py
@@ -11,0 +12,17 @@ def existing():
+added line 12
+added line 13
+added line 14
+added line 15
+added line 16
+added line 17
+added line 18
+added line 19
+added line 20
+added line 21
+added line 22
+added line 23
+added line 24
+added line 25
+added line 26
+added line 27
+added line 28
diff --git a/agent/core/bar.py b/agent/core/bar.py
index 3333333..4444444 100644
--- a/agent/core/bar.py
+++ b/agent/core/bar.py
@@ -1,2 +1,3 @@
 keep
+new bar line
 keep2
"""

DIFF_PURE_DELETE = """\
diff --git a/agent/core/gone.py b/agent/core/gone.py
index 5555555..6666666 100644
--- a/agent/core/gone.py
+++ b/agent/core/gone.py
@@ -5,3 +5,0 @@ def doomed():
-removed line 5
-removed line 6
-removed line 7
"""

DIFF_DELETED_FILE = """\
diff --git a/agent/core/dead.py b/agent/core/dead.py
deleted file mode 100644
index 7777777..0000000
--- a/agent/core/dead.py
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
"""


class TestScopeDiff:
    def test_two_files_added_ranges(self) -> None:
        units = scope_diff(DIFF_TWO_FILES)
        by_path = {u.path: u for u in units}
        assert set(by_path) == {"agent/core/foo.py", "agent/core/bar.py"}

        foo = by_path["agent/core/foo.py"]
        # 17 consecutive added lines starting at 12 → merged range (12, 28).
        assert foo.added_ranges == [(12, 28)]
        assert isinstance(foo, ChangedUnit)

        bar = by_path["agent/core/bar.py"]
        assert bar.added_ranges == [(2, 2)]

    def test_pure_deletion_yields_no_added_ranges(self) -> None:
        units = scope_diff(DIFF_PURE_DELETE)
        # A file with only deletions produces no added ranges → excluded entirely.
        assert all(u.added_ranges for u in units)
        assert "agent/core/gone.py" not in {u.path for u in units}

    def test_deleted_file_skipped(self) -> None:
        units = scope_diff(DIFF_DELETED_FILE)
        assert units == []

    def test_empty_diff(self) -> None:
        assert scope_diff("") == []
