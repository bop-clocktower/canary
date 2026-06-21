"""Tests for agent/history/detector.py — flakiness and regression detection."""

from __future__ import annotations

import pytest
from agent.history.detector import (
    classify_flake_trend,
    detect_regressions,
    FlakeTrend,
)


class TestClassifyFlakeTrend:
    def test_rising_trend(self):
        # Flake rates: low early, high recently
        rates = [0.05, 0.05, 0.10, 0.20, 0.35, 0.40]
        assert classify_flake_trend(rates) == FlakeTrend.RISING

    def test_falling_trend(self):
        rates = [0.40, 0.35, 0.20, 0.10, 0.05, 0.02]
        assert classify_flake_trend(rates) == FlakeTrend.FALLING

    def test_stable_trend(self):
        rates = [0.15, 0.16, 0.14, 0.15, 0.15, 0.16]
        assert classify_flake_trend(rates) == FlakeTrend.STABLE

    def test_empty_returns_stable(self):
        assert classify_flake_trend([]) == FlakeTrend.STABLE

    def test_single_point_returns_stable(self):
        assert classify_flake_trend([0.5]) == FlakeTrend.STABLE

    def test_two_points_rising(self):
        assert classify_flake_trend([0.1, 0.5]) == FlakeTrend.RISING

    def test_two_points_falling(self):
        assert classify_flake_trend([0.5, 0.1]) == FlakeTrend.FALLING


class TestDetectRegressions:
    def _make_timeline(self, statuses: list[str]) -> list[dict]:
        return [
            {"run_id": f"r{i}", "status": s, "commit_sha": f"abc{i:04d}",
             "timestamp": f"2026-06-{i+1:02d}T00:00:00Z"}
            for i, s in enumerate(statuses)
        ]

    def test_detects_regression_after_green_streak(self):
        # 5 passes then 3 failures
        timeline = self._make_timeline(["passed"] * 5 + ["failed"] * 3)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        assert result["is_regression"] is True

    def test_no_regression_if_insufficient_green_streak(self):
        # Only 3 passes (need 5) then failures
        timeline = self._make_timeline(["passed"] * 3 + ["failed"] * 3)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        assert result["is_regression"] is False

    def test_no_regression_if_not_enough_recent_failures(self):
        # 5 passes, 1 fail, 2 passes — not recently broken enough
        timeline = self._make_timeline(["passed"] * 5 + ["failed"] + ["passed"] * 2)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        assert result["is_regression"] is False

    def test_no_regression_on_empty_timeline(self):
        result = detect_regressions([], min_green=5, recent_failures=3)
        assert result["is_regression"] is False

    def test_regression_identifies_first_failure_commit(self):
        timeline = self._make_timeline(["passed"] * 5 + ["failed"] * 3)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        # First failure is at index 5
        assert result["first_failure_commit"] == "abc0005"

    def test_regression_result_includes_green_streak_length(self):
        timeline = self._make_timeline(["passed"] * 7 + ["failed"] * 3)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        assert result["green_streak"] == 7

    def test_flaky_counts_as_failure_for_regression(self):
        # Green then flaky should count as regression candidate
        timeline = self._make_timeline(["passed"] * 5 + ["flaky"] * 3)
        result = detect_regressions(timeline, min_green=5, recent_failures=3)
        assert result["is_regression"] is True
