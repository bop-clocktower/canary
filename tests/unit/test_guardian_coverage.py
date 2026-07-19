"""TDD for agent.guardian.coverage — tiered coverage fidelity resolver.

Phase 1 (deterministic, agent-free). SC-3: highest-available-fidelity
resolution per changed unit (report > graph > heuristic), each labeled.
"""

from __future__ import annotations

from agent.guardian.coverage import (
    ChangedUnit,
    CoverageResult,
    Fidelity,
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
