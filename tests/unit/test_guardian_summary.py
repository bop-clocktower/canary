"""Tests for agent/guardian/summary_emitter.py — impact summary Markdown."""

from __future__ import annotations

from agent.guardian.diff_extractor import ChangeType
from agent.guardian.impact_mapper import ImpactGap, Severity
from agent.guardian.summary_emitter import build_summary


def _gap(path: str, method: str, change_type: ChangeType,
         severity: Severity, tests: list[str] | None = None) -> ImpactGap:
    return ImpactGap(
        path=path,
        method=method,
        operation_id="op",
        change_type=change_type,
        severity=severity,
        affected_tests=tests or [],
    )


class TestBuildSummary:
    def test_no_gaps_returns_clean_message(self):
        md = build_summary(gaps=[], commit_sha="abc1234", suite="api")
        assert (
            "no impact" in md.lower()
            or "no gaps" in md.lower()
            or "clean" in md.lower()
            or "unchanged" in md.lower()
        )

    def test_includes_commit_sha(self):
        md = build_summary(gaps=[], commit_sha="abc1234", suite="api")
        assert "abc1234" in md

    def test_includes_new_endpoint_section(self):
        gaps = [_gap("/v2/new", "post", ChangeType.ADDED, Severity.HIGH)]
        md = build_summary(gaps=gaps, commit_sha="abc1234", suite="api")
        assert "/v2/new" in md
        assert "New endpoint" in md or "Added" in md

    def test_includes_removed_endpoint_section(self):
        gaps = [_gap("/v2/old", "delete", ChangeType.REMOVED, Severity.CRITICAL,
                     tests=["DELETE /v2/old - should remove"])]
        md = build_summary(gaps=gaps, commit_sha="abc1234", suite="api")
        assert "/v2/old" in md
        assert "Removed" in md or "removed" in md

    def test_includes_changed_endpoint_section(self):
        gaps = [_gap("/v2/members", "get", ChangeType.CHANGED, Severity.MEDIUM,
                     tests=["GET /v2/members - should list"])]
        md = build_summary(gaps=gaps, commit_sha="abc1234", suite="api")
        assert "/v2/members" in md
        assert "Changed" in md or "changed" in md

    def test_recommended_actions_section_present(self):
        gaps = [_gap("/v2/new", "post", ChangeType.ADDED, Severity.HIGH)]
        md = build_summary(gaps=gaps, commit_sha="abc1234", suite="api")
        assert "Recommended" in md or "recommended" in md.lower()

    def test_critical_gap_shows_affected_tests(self):
        tests = ["DELETE /v2/old - test 1", "DELETE /v2/old - test 2"]
        gaps = [_gap("/v2/old", "delete", ChangeType.REMOVED, Severity.CRITICAL, tests=tests)]
        md = build_summary(gaps=gaps, commit_sha="abc1234", suite="api")
        assert "test 1" in md or "test 2" in md

    def test_returns_string(self):
        md = build_summary(gaps=[], commit_sha="abc1234", suite="api")
        assert isinstance(md, str)
        assert len(md) > 0
