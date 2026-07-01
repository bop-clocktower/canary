"""Tests for agent/analysis/ — cross-suite query reports."""

from __future__ import annotations

from agent.analysis.reports import (
    build_flaky_report,
    build_spikes_report,
    build_area_health_report,
    build_common_failures_report,
    build_regression_candidates_report,
    build_digest,
)


# ---------------------------------------------------------------------------
# Shared fixture data helpers
# ---------------------------------------------------------------------------

def _flaky_row(test_name: str, suite: str, area: str,
               flake_rate_pct: float, flake_count: int = 3, total_runs: int = 10,
               last_seen_run: str = "r1") -> dict:
    return {
        "test_name": test_name,
        "suite": suite,
        "area": area,
        "flake_rate_pct": flake_rate_pct,
        "flake_count": flake_count,
        "pass_count": total_runs - flake_count,
        "fail_count": 0,
        "total_runs": total_runs,
        "last_seen_run": last_seen_run,
    }


def _run_row(suite: str, timestamp: str, passed: int, failed: int,
             flaky: int = 0, total: int | None = None) -> dict:
    return {
        "suite": suite,
        "timestamp": timestamp,
        "passed": passed,
        "failed": failed,
        "flaky": flaky,
        "total": total or (passed + failed + flaky),
    }


class TestBuildFlakyReport:
    def test_empty_rows_returns_no_issues_message(self):
        md = build_flaky_report([], window=30, min_rate=10.0)
        assert "No tests" in md or "no tests" in md.lower()

    def test_renders_table_header(self):
        rows = [_flaky_row("test A", "api", "members", 34.0)]
        md = build_flaky_report(rows, window=30, min_rate=10.0)
        assert "Test" in md
        assert "Flake %" in md

    def test_renders_test_name(self):
        rows = [_flaky_row("test A", "api", "members", 34.0)]
        md = build_flaky_report(rows, window=30, min_rate=10.0)
        assert "test A" in md

    def test_renders_rate(self):
        rows = [_flaky_row("test A", "api", "members", 34.0)]
        md = build_flaky_report(rows, window=30, min_rate=10.0)
        assert "34.0%" in md or "34%" in md

    def test_orders_highest_rate_first(self):
        rows = [
            _flaky_row("test A", "api", "members", 15.0),
            _flaky_row("test B", "api", "auth", 40.0),
        ]
        md = build_flaky_report(rows, window=30, min_rate=10.0)
        assert md.index("test B") < md.index("test A")

    def test_includes_window_in_header(self):
        rows = [_flaky_row("test A", "api", "members", 34.0)]
        md = build_flaky_report(rows, window=30, min_rate=10.0)
        assert "30" in md


class TestBuildSpikesReport:
    def _runs(self, suite, early_pass_rate, recent_pass_rate, n=10):
        mid = n // 2
        rows = []
        for i in range(mid):
            p = int(100 * early_pass_rate)
            rows.append(_run_row(suite, f"2026-06-0{i+1}T00:00:00Z", p, 100 - p, total=100))
        for i in range(mid, n):
            p = int(100 * recent_pass_rate)
            rows.append(_run_row(suite, f"2026-06-{i+1:02d}T00:00:00Z", p, 100 - p, total=100))
        return rows

    def test_detects_spike(self):
        runs = self._runs("api", early_pass_rate=0.98, recent_pass_rate=0.60)
        md = build_spikes_report(runs, delta=20.0)
        assert "api" in md
        assert "spike" in md.lower() or "%" in md

    def test_no_spike_when_stable(self):
        runs = self._runs("api", early_pass_rate=0.95, recent_pass_rate=0.94)
        md = build_spikes_report(runs, delta=20.0)
        assert "No spikes" in md or "no spikes" in md.lower()

    def test_empty_runs_no_crash(self):
        md = build_spikes_report([], delta=20.0)
        assert isinstance(md, str)


class TestBuildAreaHealthReport:
    def _area_rows(self, area, suite, pass_rates_by_week):
        rows = []
        for week, rate in enumerate(pass_rates_by_week):
            p = int(100 * rate)
            rows.append({
                "area": area,
                "suite": suite,
                "week": f"2026-W{week+1:02d}",
                "pass_rate": rate,
                "passed": p,
                "total": 100,
            })
        return rows

    def test_renders_area_names(self):
        rows = (
            self._area_rows("members", "api", [0.95, 0.90, 0.85, 0.80])
            + self._area_rows("auth", "api", [0.99, 0.98, 0.97, 0.99])
        )
        md = build_area_health_report(rows, weeks=4)
        assert "members" in md
        assert "auth" in md

    def test_flags_degrading_area(self):
        rows = self._area_rows("members", "api", [0.95, 0.90, 0.85, 0.75])
        md = build_area_health_report(rows, weeks=4)
        assert "members" in md
        assert "↓" in md or "degrading" in md.lower() or "decline" in md.lower()

    def test_empty_rows_no_crash(self):
        md = build_area_health_report([], weeks=4)
        assert isinstance(md, str)


class TestBuildCommonFailuresReport:
    def _failure_row(self, test_name, suite, error_text, category="other") -> dict:
        return {
            "test_name": test_name,
            "suite": suite,
            "failure_category": category,
            "error_text": error_text,
            "run_count": 3,
        }

    def test_groups_matching_errors(self):
        rows = [
            self._failure_row("test A", "api", "401 Unauthorized — token expired"),
            self._failure_row("test B", "e2e_ui", "401 Unauthorized — token expired"),
        ]
        md = build_common_failures_report(rows, min_suites=2)
        assert "401 Unauthorized" in md

    def test_excludes_single_suite_failures(self):
        rows = [
            self._failure_row("test A", "api", "unique error only in api"),
        ]
        md = build_common_failures_report(rows, min_suites=2)
        assert "unique error only in api" not in md

    def test_empty_rows_no_crash(self):
        md = build_common_failures_report([], min_suites=2)
        assert isinstance(md, str)


class TestBuildRegressionCandidatesReport:
    def test_renders_regression_test(self):
        rows = [
            {
                "test_name": "test A",
                "suite": "api",
                "area": "members",
                "green_streak": 8,
                "first_failure_commit": "abc12345",
                "recent_failures": 3,
            }
        ]
        md = build_regression_candidates_report(rows)
        assert "test A" in md
        assert "abc12345" in md

    def test_empty_returns_no_candidates_message(self):
        md = build_regression_candidates_report([])
        assert "No regression" in md or "no regression" in md.lower()


class TestBuildDigest:
    def test_digest_includes_all_sections(self):
        digest = build_digest(
            flaky=[],
            spikes=[],
            area_health=[],
            common_failures=[],
            regression_candidates=[],
            window=30,
            delta=20.0,
            weeks=4,
            min_suites=2,
        )
        assert "Flaky" in digest or "flaky" in digest.lower()
        assert "Spike" in digest or "spike" in digest.lower()
        assert "Area" in digest or "area" in digest.lower()
        assert "Regression" in digest or "regression" in digest.lower()

    def test_digest_returns_string(self):
        digest = build_digest(
            flaky=[], spikes=[], area_health=[],
            common_failures=[], regression_candidates=[],
            window=30, delta=20.0, weeks=4, min_suites=2,
        )
        assert isinstance(digest, str)
        assert len(digest) > 0
