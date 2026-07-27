"""TDD for the guardian's advisory weak-test finding.

An added test that asserts nothing sails through the guardian today (it only
flags ABSENT tests). `build_weak_test_findings` emits an advisory `weak-test`
finding for such additions — never gating (see `compute_exit_code`).
"""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from agent.guardian.cli import guardian_app
from agent.guardian.pr_check import (
    GuardianConfig,
    build_weak_test_findings,
    compute_exit_code,
    load_guardian_config,
    scope_diff,
    filter_test_units,
)

_DIFF_WEAK_PY = """\
diff --git a/tests/test_widget.py b/tests/test_widget.py
new file mode 100644
--- /dev/null
+++ b/tests/test_widget.py
@@ -0,0 +1,3 @@
+def test_widget():
+    w = make_widget()
+    print(w)
"""

_DIFF_STRONG_PY = """\
diff --git a/tests/test_widget.py b/tests/test_widget.py
new file mode 100644
--- /dev/null
+++ b/tests/test_widget.py
@@ -0,0 +1,3 @@
+def test_widget():
+    w = make_widget()
+    assert w.size == 1
"""

_DIFF_WEAK_TS = """\
diff --git a/src/widget.test.ts b/src/widget.test.ts
new file mode 100644
--- /dev/null
+++ b/src/widget.test.ts
@@ -0,0 +1,3 @@
+it('builds a widget', () => {
+  const w = makeWidget()
+  console.log(w)
+})
"""


# FP-3: a rename adds only the signature; the asserting body is context (not a
# `+` line). Must NOT be flagged — there's no added body to judge.
_DIFF_RENAME_ONLY = """\
diff --git a/tests/test_widget.py b/tests/test_widget.py
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -1,3 +1,3 @@
+def test_widget_renamed():
-def test_widget():
     w = make_widget()
     assert w.size == 1
"""


def _test_units(diff: str):
    _, test_units = filter_test_units(scope_diff(diff))
    return test_units


class TestBuildWeakTestFindings:
    def test_flags_assertion_free_python_test(self) -> None:
        findings = build_weak_test_findings(_test_units(_DIFF_WEAK_PY), _DIFF_WEAK_PY)
        assert len(findings) == 1
        f = findings[0]
        assert f.kind == "weak-test"
        assert f.path == "tests/test_widget.py"
        assert f.evidence  # explains why

    def test_does_not_flag_test_with_assertion(self) -> None:
        findings = build_weak_test_findings(
            _test_units(_DIFF_STRONG_PY), _DIFF_STRONG_PY
        )
        assert findings == []

    def test_flags_assertion_free_typescript_test(self) -> None:
        findings = build_weak_test_findings(_test_units(_DIFF_WEAK_TS), _DIFF_WEAK_TS)
        assert len(findings) == 1
        assert findings[0].path == "src/widget.test.ts"

    def test_rename_only_diff_is_not_flagged(self) -> None:
        # FP-3: no added body (asserting body is unchanged context) → not weak.
        findings = build_weak_test_findings(
            _test_units(_DIFF_RENAME_ONLY), _DIFF_RENAME_ONLY
        )
        assert findings == []

    def test_weak_findings_never_gate_even_hard(self) -> None:
        findings = build_weak_test_findings(_test_units(_DIFF_WEAK_PY), _DIFF_WEAK_PY)
        assert compute_exit_code(findings, gate="hard") == 0


class TestWeakTestsConfigToggle:
    def test_default_enabled(self) -> None:
        assert GuardianConfig().weak_tests is True

    def test_config_can_disable(self, tmp_path: Path) -> None:
        cfg = tmp_path / "harness.config.json"
        cfg.write_text(
            json.dumps({"canary": {"guardian": {"pr": {"weakTests": False}}}}),
            encoding="utf-8",
        )
        config, _ = load_guardian_config(cfg)
        assert config.weak_tests is False

    def test_config_omitted_keeps_default(self, tmp_path: Path) -> None:
        cfg = tmp_path / "harness.config.json"
        cfg.write_text(
            json.dumps({"canary": {"guardian": {"pr": {"enabled": True}}}}),
            encoding="utf-8",
        )
        config, _ = load_guardian_config(cfg)
        assert config.weak_tests is True


class TestWeakTestCliEndToEnd:
    runner = CliRunner()

    def test_weak_test_only_diff_surfaces_not_nothing_to_verify(
        self, tmp_path, monkeypatch
    ) -> None:
        # A diff that ONLY adds an assertion-free test must NOT short-circuit at
        # "nothing to verify" — it should surface the advisory finding, exit 0.
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json", "--gate", "hard"],
            input=_DIFF_WEAK_PY,
        )
        assert result.exit_code == 0  # advisory never gates, even hard
        assert "nothing to verify" not in result.stdout
        data = json.loads(result.stdout)
        kinds = {f["kind"] for f in data["findings"]}
        assert "weak-test" in kinds

    def test_disabled_via_flag_config(self, tmp_path, monkeypatch) -> None:
        monkeypatch.chdir(tmp_path)
        cfg = tmp_path / "harness.config.json"
        cfg.write_text(
            json.dumps({"canary": {"guardian": {"pr": {"weakTests": False}}}}),
            encoding="utf-8",
        )
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--config", str(cfg), "--format", "json"],
            input=_DIFF_WEAK_PY,
        )
        # With weak-tests off and no source units, it's back to nothing-to-verify.
        assert result.exit_code == 0
        assert "nothing to verify" in result.stdout
