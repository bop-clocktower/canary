"""Flakiness and regression detection on top of history query results.

Pure functions — no I/O. Input is the list[dict] output from store.query_*().
"""

from __future__ import annotations

from enum import Enum


class FlakeTrend(str, Enum):
    RISING = "rising"
    FALLING = "falling"
    STABLE = "stable"


_TREND_THRESHOLD = 0.10


def classify_flake_trend(rates: list[float]) -> FlakeTrend:
    """Given a time-ordered list of per-run flake rates (0.0–1.0), classify trend.

    Uses a simple first-half vs second-half mean comparison. Works well enough
    for the window sizes we operate on (10–50 runs); no need for regression fit.
    """
    if len(rates) < 2:
        return FlakeTrend.STABLE

    mid = len(rates) // 2
    first_half = rates[:mid]
    second_half = rates[mid:]

    early_mean = sum(first_half) / len(first_half)
    recent_mean = sum(second_half) / len(second_half)
    delta = recent_mean - early_mean

    if delta >= _TREND_THRESHOLD:
        return FlakeTrend.RISING
    if delta <= -_TREND_THRESHOLD:
        return FlakeTrend.FALLING
    return FlakeTrend.STABLE


def detect_regressions(
    timeline: list[dict],
    min_green: int = 5,
    recent_failures: int = 3,
) -> dict:
    """Detect whether a test has regressed: green for min_green runs, then failing.

    A test is a regression candidate when:
    - It was green (status == 'passed') for at least min_green consecutive runs
    - The last recent_failures runs are all non-passing (failed or flaky)

    Returns a dict with keys: is_regression, green_streak, first_failure_commit.
    """
    if not timeline:
        return {"is_regression": False, "green_streak": 0, "first_failure_commit": None}

    _bad = {"failed", "flaky"}

    # Check that the last recent_failures runs are all bad
    tail = timeline[-recent_failures:] if len(timeline) >= recent_failures else []
    if len(tail) < recent_failures:
        return {"is_regression": False, "green_streak": 0, "first_failure_commit": None}

    if not all(r["status"] in _bad for r in tail):
        return {"is_regression": False, "green_streak": 0, "first_failure_commit": None}

    # Find the longest consecutive green streak immediately before the first tail failure
    first_fail_idx = len(timeline) - recent_failures
    streak = 0
    for i in range(first_fail_idx - 1, -1, -1):
        if timeline[i]["status"] == "passed":
            streak += 1
        else:
            break

    if streak < min_green:
        return {"is_regression": False, "green_streak": streak, "first_failure_commit": None}

    first_failure_commit = timeline[first_fail_idx].get("commit_sha")
    return {
        "is_regression": True,
        "green_streak": streak,
        "first_failure_commit": first_failure_commit,
    }
