"""TDD for agent.guardian.coverage — tiered coverage fidelity resolver.

Phase 1 (deterministic, agent-free). SC-3: highest-available-fidelity
resolution per changed unit (report > graph > heuristic), each labeled.
"""

from __future__ import annotations

from pathlib import Path

from agent.guardian.coverage import (
    ChangedUnit,
    CoverageResult,
    Fidelity,
    resolve_from_report,
)


class TestShapes:
    def test_fidelity_rank_order(self) -> None:
        # Lower rank == higher fidelity.
        assert Fidelity.COVERAGE_VERIFIED.rank < Fidelity.GRAPH_VERIFIED.rank
        assert Fidelity.GRAPH_VERIFIED.rank < Fidelity.HEURISTIC.rank

    def test_fidelity_str_values(self) -> None:
        assert Fidelity.COVERAGE_VERIFIED.value == "coverage-verified"
        assert Fidelity.GRAPH_VERIFIED.value == "graph-verified"
        assert Fidelity.HEURISTIC.value == "heuristic"

    def test_changed_unit_fields(self) -> None:
        unit = ChangedUnit(path="agent/core/foo.py", added_ranges=[(12, 28)])
        assert unit.path == "agent/core/foo.py"
        assert unit.added_ranges == [(12, 28)]
        assert unit.symbol is None

    def test_coverage_result_fields(self) -> None:
        unit = ChangedUnit(path="agent/core/foo.py", added_ranges=[(1, 3)])
        result = CoverageResult(
            unit=unit,
            covered=False,
            fidelity=Fidelity.HEURISTIC,
            evidence="no test references foo",
            uncovered_lines=[1, 2, 3],
        )
        assert result.unit is unit
        assert result.covered is False
        assert result.fidelity is Fidelity.HEURISTIC
        assert result.evidence == "no test references foo"
        assert result.uncovered_lines == [1, 2, 3]

    def test_coverage_result_uncovered_defaults_empty(self) -> None:
        unit = ChangedUnit(path="x.py", added_ranges=[(1, 1)])
        result = CoverageResult(
            unit=unit,
            covered=True,
            fidelity=Fidelity.COVERAGE_VERIFIED,
            evidence="all hit",
        )
        assert result.uncovered_lines == []


LCOV_FIXTURE = """\
SF:pkg/foo.py
DA:12,3
DA:13,1
DA:14,0
DA:15,2
end_of_record
SF:pkg/bar.py
DA:1,5
DA:2,4
end_of_record
"""

JSON_FIXTURE = {
    "files": {
        "pkg/foo.py": {"covered_lines": [12, 13, 15]},
        "pkg/bar.py": {"covered_lines": [1, 2]},
    }
}


class TestResolveFromReport:
    def _units(self):
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(12, 15)])
        bar = ChangedUnit(path="pkg/bar.py", added_ranges=[(1, 2)])
        return foo, bar

    def test_lcov_covered_and_uncovered(self, tmp_path: Path) -> None:
        report = tmp_path / "lcov.info"
        report.write_text(LCOV_FIXTURE, encoding="utf-8")
        foo, bar = self._units()

        results = resolve_from_report([foo, bar], report)
        assert results is not None
        by_path = {r.unit.path: r for r in results}

        # foo added line 14 has 0 hits → uncovered.
        assert by_path["pkg/foo.py"].covered is False
        assert by_path["pkg/foo.py"].uncovered_lines == [14]
        assert by_path["pkg/foo.py"].fidelity is Fidelity.COVERAGE_VERIFIED

        # bar all added lines hit → covered.
        assert by_path["pkg/bar.py"].covered is True
        assert by_path["pkg/bar.py"].uncovered_lines == []
        assert by_path["pkg/bar.py"].fidelity is Fidelity.COVERAGE_VERIFIED

    def test_json_covered_and_uncovered(self, tmp_path: Path) -> None:
        import json

        report = tmp_path / "coverage.json"
        report.write_text(json.dumps(JSON_FIXTURE), encoding="utf-8")
        foo, bar = self._units()

        results = resolve_from_report([foo, bar], report)
        assert results is not None
        by_path = {r.unit.path: r for r in results}

        # foo line 14 absent from covered_lines → uncovered.
        assert by_path["pkg/foo.py"].covered is False
        assert by_path["pkg/foo.py"].uncovered_lines == [14]
        assert by_path["pkg/bar.py"].covered is True

    def test_unrecognized_format_returns_none(self, tmp_path: Path) -> None:
        report = tmp_path / "coverage.xml"
        report.write_text("<coverage/>", encoding="utf-8")
        foo, _ = self._units()
        assert resolve_from_report([foo], report) is None

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        foo, _ = self._units()
        assert resolve_from_report([foo], tmp_path / "nope.json") is None
