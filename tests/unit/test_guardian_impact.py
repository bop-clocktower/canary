"""Tests for agent/guardian/impact_mapper.py — diff → test impact mapping."""

from __future__ import annotations

from agent.guardian.diff_extractor import EndpointChange, ChangeType, ApiDiff
from agent.guardian.impact_mapper import map_impact, Severity


def _change(path: str, method: str, change_type: ChangeType,
            operation_id: str = "op") -> EndpointChange:
    return EndpointChange(
        path=path, method=method, change_type=change_type, operation_id=operation_id
    )


def _coverage_row(path: str, method: str, test_name: str, suite: str = "api") -> dict:
    return {
        "path": path,
        "method": method,
        "test_name": test_name,
        "suite": suite,
        "test_file": f"tests/{suite}/test.spec.ts",
    }


class TestMapImpact:
    def test_new_endpoint_with_no_coverage_is_high_severity(self):
        diff = ApiDiff(
            added=[_change("/v2/new", "post", ChangeType.ADDED)],
            removed=[],
            changed=[],
        )
        gaps = map_impact(diff, coverage_rows=[])
        assert len(gaps) == 1
        assert gaps[0].severity == Severity.HIGH
        assert gaps[0].change_type == ChangeType.ADDED
        assert gaps[0].affected_tests == []

    def test_removed_endpoint_with_tests_is_critical(self):
        diff = ApiDiff(
            added=[],
            removed=[_change("/v2/old", "delete", ChangeType.REMOVED)],
            changed=[],
        )
        coverage = [_coverage_row("/v2/old", "delete", "DELETE /v2/old - should remove")]
        gaps = map_impact(diff, coverage_rows=coverage)
        assert len(gaps) == 1
        assert gaps[0].severity == Severity.CRITICAL
        assert len(gaps[0].affected_tests) == 1

    def test_changed_endpoint_with_tests_is_medium_severity(self):
        diff = ApiDiff(
            added=[],
            removed=[],
            changed=[_change("/v2/members", "get", ChangeType.CHANGED)],
        )
        coverage = [_coverage_row("/v2/members", "get", "GET /v2/members - should list")]
        gaps = map_impact(diff, coverage_rows=coverage)
        assert len(gaps) == 1
        assert gaps[0].severity == Severity.MEDIUM
        assert len(gaps[0].affected_tests) == 1

    def test_changed_endpoint_without_tests_is_high_severity(self):
        diff = ApiDiff(
            added=[],
            removed=[],
            changed=[_change("/v2/members", "get", ChangeType.CHANGED)],
        )
        gaps = map_impact(diff, coverage_rows=[])
        assert gaps[0].severity == Severity.HIGH

    def test_no_diff_returns_empty_gaps(self):
        diff = ApiDiff(added=[], removed=[], changed=[])
        gaps = map_impact(diff, coverage_rows=[])
        assert gaps == []

    def test_path_parameter_matching(self):
        diff = ApiDiff(
            added=[],
            removed=[],
            changed=[_change("/v2/members/{id}", "get", ChangeType.CHANGED)],
        )
        coverage = [
            _coverage_row("/v2/members/{id}", "get", "GET /v2/members/:id - should return member"),
            _coverage_row("/v2/members/{id}", "get", "GET /v2/members/:id - should handle 404"),
        ]
        gaps = map_impact(diff, coverage_rows=coverage)
        assert len(gaps[0].affected_tests) == 2

    def test_gaps_sorted_by_severity(self):
        diff = ApiDiff(
            added=[_change("/v2/new", "post", ChangeType.ADDED)],
            removed=[_change("/v2/old", "delete", ChangeType.REMOVED)],
            changed=[_change("/v2/existing", "get", ChangeType.CHANGED)],
        )
        gaps = map_impact(diff, coverage_rows=[
            _coverage_row("/v2/old", "delete", "test for old"),
        ])
        severities = [g.severity for g in gaps]
        # CRITICAL should come before HIGH
        assert severities.index(Severity.CRITICAL) < severities.index(Severity.HIGH)
