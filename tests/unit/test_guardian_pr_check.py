"""TDD for agent.guardian.pr_check — Tier 0 deterministic PR engine.

Phase 1 (agent-free). Covers diff scoping, findings, suppression, gate exit
codes, renderers, and the CLI wiring.
"""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from agent.guardian.cli import guardian_app
from agent.guardian.coverage import ChangedUnit, CoverageResult, Fidelity
from agent.guardian.impact_mapper import Severity
from agent.guardian.pr_check import (
    Finding,
    apply_suppressions,
    build_findings,
    compute_exit_code,
    filter_skipped,
    render,
    scope_diff,
)


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

    def test_added_body_line_starting_plus_plus_not_phantom_header(self) -> None:
        # FIX 7: an added content line whose text is `++ evil` appears in the
        # unified diff as `+++ evil` inside the hunk body. It must be counted as
        # an added line of the real file, NOT parsed as a `+++ ` file header
        # (which would spawn a phantom `evil` unit and drop the real add).
        diff = (
            "diff --git a/pkg/mod.py b/pkg/mod.py\n"
            "index 1111111..2222222 100644\n"
            "--- a/pkg/mod.py\n"
            "+++ b/pkg/mod.py\n"
            "@@ -1,2 +1,3 @@\n"
            " keep\n"
            "+++ evil\n"
            " keep2\n"
        )
        units = scope_diff(diff)
        by_path = {u.path: u for u in units}
        assert "evil" not in by_path  # no phantom file header
        assert "pkg/mod.py" in by_path
        # The `+++ evil` add lands on new-file line 2 (after context ` keep`).
        assert by_path["pkg/mod.py"].added_ranges == [(2, 2)]


def _result(covered: bool, fidelity: Fidelity, path: str = "pkg/foo.py",
            evidence: str = "ev") -> CoverageResult:
    return CoverageResult(
        unit=ChangedUnit(path=path, added_ranges=[(1, 3)]),
        covered=covered,
        fidelity=fidelity,
        evidence=evidence,
    )


class TestBuildFindings:
    def test_covered_result_yields_no_finding(self) -> None:
        results = [_result(True, Fidelity.COVERAGE_VERIFIED)]
        assert build_findings(results) == []

    def test_uncovered_heuristic_is_medium(self) -> None:
        findings = build_findings([_result(False, Fidelity.HEURISTIC)])
        assert len(findings) == 1
        assert findings[0].severity is Severity.MEDIUM
        assert findings[0].fidelity is Fidelity.HEURISTIC
        assert findings[0].kind == "untested-new-code"

    def test_uncovered_graph_is_high(self) -> None:
        findings = build_findings([_result(False, Fidelity.GRAPH_VERIFIED)])
        assert findings[0].severity is Severity.HIGH

    def test_uncovered_report_is_high(self) -> None:
        findings = build_findings([_result(False, Fidelity.COVERAGE_VERIFIED)])
        assert findings[0].severity is Severity.HIGH

    def test_findings_sorted_critical_to_low(self) -> None:
        results = [
            _result(False, Fidelity.HEURISTIC, path="a.py"),        # MEDIUM
            _result(False, Fidelity.GRAPH_VERIFIED, path="b.py"),   # HIGH
        ]
        findings = build_findings(results)
        assert [f.severity for f in findings] == [Severity.HIGH, Severity.MEDIUM]

    def test_evidence_and_path_propagated(self) -> None:
        results = [_result(False, Fidelity.GRAPH_VERIFIED, path="pkg/bar.py",
                           evidence="no test reaches pkg/bar.py")]
        finding = build_findings(results)[0]
        assert finding.path == "pkg/bar.py"
        assert finding.evidence == "no test reaches pkg/bar.py"
        assert isinstance(finding, Finding)


class TestSuppressions:
    def test_hash_annotation_suppresses(self, tmp_path) -> None:
        src = tmp_path / "pkg" / "foo.py"
        src.parent.mkdir(parents=True)
        src.write_text(
            "def foo():\n    return 1  # canary:allow-untested legacy shim\n",
            encoding="utf-8",
        )
        findings = [Finding(path="pkg/foo.py", unit="foo")]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is True
        assert out[0].suppression_reason == "legacy shim"

    def test_slash_annotation_suppresses(self, tmp_path) -> None:
        src = tmp_path / "pkg" / "foo.ts"
        src.parent.mkdir(parents=True)
        src.write_text(
            "export function foo() {} // canary:allow-untested vendor code\n",
            encoding="utf-8",
        )
        findings = [Finding(path="pkg/foo.ts", unit="foo")]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is True
        assert out[0].suppression_reason == "vendor code"

    def test_no_annotation_not_suppressed(self, tmp_path) -> None:
        src = tmp_path / "pkg" / "bar.py"
        src.parent.mkdir(parents=True)
        src.write_text("def bar():\n    return 2\n", encoding="utf-8")
        findings = [Finding(path="pkg/bar.py", unit="bar")]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is False
        assert out[0].suppression_reason is None

    def test_suppressed_finding_stays_in_list(self, tmp_path) -> None:
        src = tmp_path / "a.py"
        src.write_text("x = 1  # canary:allow-untested reason\n", encoding="utf-8")
        findings = [Finding(path="a.py", unit="a")]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert len(out) == 1

    def test_string_literal_token_does_not_suppress(self, tmp_path) -> None:
        # FIX 1: the token inside a string literal (no comment leader) must NOT
        # clear the gate — it is prose/data, not an author annotation.
        src = tmp_path / "pkg" / "foo.py"
        src.parent.mkdir(parents=True)
        src.write_text(
            'def foo():\n    x = "canary:allow-untested bypass"\n    return x\n',
            encoding="utf-8",
        )
        findings = [
            Finding(path="pkg/foo.py", unit="foo", added_ranges=[(1, 3)])
        ]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is False
        assert out[0].suppression_reason is None

    def test_comment_leader_on_added_line_suppresses(self, tmp_path) -> None:
        # FIX 1: a genuine comment annotation on an added line clears the gate.
        src = tmp_path / "pkg" / "foo.py"
        src.parent.mkdir(parents=True)
        src.write_text(
            "def foo():\n    return 1  # canary:allow-untested legacy shim\n",
            encoding="utf-8",
        )
        findings = [
            Finding(path="pkg/foo.py", unit="foo", added_ranges=[(2, 2)])
        ]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is True
        assert out[0].suppression_reason == "legacy shim"

    def test_annotation_outside_added_range_ignored(self, tmp_path) -> None:
        # FIX 1: an annotation on a line the diff did NOT touch must not suppress
        # the finding — suppression is scoped to the unit's changed lines.
        src = tmp_path / "pkg" / "foo.py"
        src.parent.mkdir(parents=True)
        src.write_text(
            "def foo():  # canary:allow-untested unrelated old comment\n"
            "    added = 1\n"
            "    return added\n",
            encoding="utf-8",
        )
        findings = [
            Finding(path="pkg/foo.py", unit="foo", added_ranges=[(2, 3)])
        ]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is False

    def test_inline_comment_close_stripped_from_reason(self, tmp_path) -> None:
        # FIX 1: a trailing inline-comment close is stripped from the reason.
        src = tmp_path / "pkg" / "foo.ts"
        src.parent.mkdir(parents=True)
        src.write_text(
            "export const x = 1;  // canary:allow-untested vendor code */\n",
            encoding="utf-8",
        )
        findings = [
            Finding(path="pkg/foo.ts", unit="x", added_ranges=[(1, 1)])
        ]
        out = apply_suppressions(findings, repo_root=tmp_path)
        assert out[0].suppressed is True
        assert out[0].suppression_reason == "vendor code"


class TestExitCode:
    def test_hard_unaddressed_high_exits_nonzero(self) -> None:
        findings = [Finding(path="a.py", unit="a", severity=Severity.HIGH)]
        assert compute_exit_code(findings, gate="hard") == 1

    def test_hard_unaddressed_critical_exits_nonzero(self) -> None:
        findings = [Finding(path="a.py", unit="a", severity=Severity.CRITICAL)]
        assert compute_exit_code(findings, gate="hard") == 1

    def test_hard_suppressed_high_exits_zero(self) -> None:
        findings = [
            Finding(path="a.py", unit="a", severity=Severity.HIGH, suppressed=True)
        ]
        assert compute_exit_code(findings, gate="hard") == 0

    def test_hard_only_medium_low_exits_zero(self) -> None:
        findings = [
            Finding(path="a.py", unit="a", severity=Severity.MEDIUM),
            Finding(path="b.py", unit="b", severity=Severity.LOW),
        ]
        assert compute_exit_code(findings, gate="hard") == 0

    def test_soft_unaddressed_critical_exits_zero(self) -> None:
        findings = [Finding(path="a.py", unit="a", severity=Severity.CRITICAL)]
        assert compute_exit_code(findings, gate="soft") == 0

    def test_empty_findings_exits_zero(self) -> None:
        assert compute_exit_code([], gate="hard") == 0

    def test_hard_wrong_kind_exits_zero(self) -> None:
        findings = [
            Finding(path="a.py", unit="a", kind="weak-test", severity=Severity.HIGH)
        ]
        assert compute_exit_code(findings, gate="hard") == 0

    def test_hard_mixed_case_still_enforces(self) -> None:
        # FIX 5: a mistyped "Hard" must NOT fail open — normalize before compare.
        findings = [Finding(path="a.py", unit="a", severity=Severity.HIGH)]
        assert compute_exit_code(findings, gate="Hard") == 1

    def test_hard_padded_still_enforces(self) -> None:
        # FIX 5: surrounding whitespace must not disable enforcement.
        findings = [Finding(path="a.py", unit="a", severity=Severity.HIGH)]
        assert compute_exit_code(findings, gate=" hard ") == 1


def _finding(**kw) -> Finding:
    base = dict(path="pkg/foo.py", unit="foo", severity=Severity.HIGH,
                fidelity=Fidelity.GRAPH_VERIFIED, evidence="no test reaches foo")
    base.update(kw)
    return Finding(**base)


class TestRender:
    def test_comment_has_sticky_marker_and_fidelity(self) -> None:
        out = render([_finding()], fmt="comment")
        assert "<!-- canary-pr-guardian -->" in out
        assert "graph-verified" in out
        assert "pkg/foo.py" in out

    def test_comment_marks_suppressed(self) -> None:
        out = render([_finding(suppressed=True, suppression_reason="legacy")],
                     fmt="comment")
        assert "suppressed" in out.lower()

    def test_comment_footer_shows_tier_and_degraded(self) -> None:
        out = render([_finding()], fmt="comment", degraded_notice="graph stale")
        assert "tier 0" in out.lower()
        assert "graph stale" in out

    def test_json_round_trips_all_findings(self) -> None:
        findings = [_finding(path="a.py", unit="a"),
                    _finding(path="b.py", unit="b", severity=Severity.MEDIUM,
                             fidelity=Fidelity.HEURISTIC)]
        out = render(findings, fmt="json")
        data = json.loads(out)
        assert data["tier"] == 0
        assert len(data["findings"]) == 2
        assert {f["path"] for f in data["findings"]} == {"a.py", "b.py"}

    def test_text_has_no_html_marker(self) -> None:
        out = render([_finding()], fmt="text")
        assert "<!--" not in out
        assert "pkg/foo.py" in out


DIFF_NEW_UNIT = """\
diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
"""


class TestPrCheckCLI:
    runner = CliRunner()

    def _seed(self, root: Path) -> None:
        (root / "pkg").mkdir()
        (root / "pkg" / "widget.py").write_text(
            "def widget():\n    return 42\n", encoding="utf-8"
        )

    def test_json_lists_finding_and_soft_exits_zero(
        self, tmp_path, monkeypatch
    ) -> None:
        self._seed(tmp_path)
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--format", "json", "--gate", "soft"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert data["tier"] == 0
        assert len(data["findings"]) >= 1
        assert data["findings"][0]["path"] == "pkg/widget.py"

    def test_hard_gate_high_uncovered_exits_nonzero(
        self, tmp_path, monkeypatch
    ) -> None:
        self._seed(tmp_path)
        # Coverage report marks every added line uncovered → HIGH finding.
        (tmp_path / "cov.info").write_text(
            "SF:pkg/widget.py\nDA:1,0\nDA:2,0\nDA:3,0\nend_of_record\n",
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)
        result = self.runner.invoke(
            guardian_app,
            ["pr-check", "--diff", "-", "--coverage", "cov.info",
             "--gate", "hard"],
            input=DIFF_NEW_UNIT,
        )
        assert result.exit_code != 0

    def test_help_discoverable(self) -> None:
        result = self.runner.invoke(guardian_app, ["pr-check", "--help"])
        assert result.exit_code == 0
        assert "--diff" in result.stdout


class TestFilterSkipped:
    """SC-2: skipGlobs excludes docs/config-only changed units."""

    def test_skips_matching_globs_order_preserving(self) -> None:
        units = [
            ChangedUnit(path="docs/guide.md", added_ranges=[(1, 2)]),
            ChangedUnit(path="README.md", added_ranges=[(1, 2)]),
            ChangedUnit(path="agent/core/foo.py", added_ranges=[(1, 2)]),
        ]
        kept, skipped = filter_skipped(units, ["docs/**", "**/*.md"])
        assert [u.path for u in kept] == ["agent/core/foo.py"]
        assert [u.path for u in skipped] == ["docs/guide.md", "README.md"]

    def test_empty_globs_keeps_all(self) -> None:
        units = [ChangedUnit(path="agent/core/foo.py", added_ranges=[(1, 2)])]
        kept, skipped = filter_skipped(units, [])
        assert kept == units
        assert skipped == []

    def test_double_star_matches_nested(self) -> None:
        units = [ChangedUnit(path="docs/a/b/c.md", added_ranges=[(1, 2)])]
        kept, skipped = filter_skipped(units, ["docs/**"])
        assert kept == []
        assert [u.path for u in skipped] == ["docs/a/b/c.md"]


class TestPackageExports:
    def test_exports(self) -> None:
        import agent.guardian as g

        assert g.Fidelity is Fidelity
        assert g.Finding is Finding
        assert g.CoverageResult is CoverageResult
