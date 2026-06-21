"""AnalysisEngine — queries the history store and runs all five report types.

The engine is a thin coordinator: it calls store.query_* methods, passes the
results to the pure builders in reports.py, and returns both structured data
and Markdown artifacts.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from agent.history.store import HistoryStore, make_store
from agent.analysis.reports import (
    build_digest,
    build_flaky_report,
    build_spikes_report,
    build_area_health_report,
    build_common_failures_report,
    build_regression_candidates_report,
)


@dataclass
class AnalysisResult:
    flaky: list[dict]
    spikes: list[dict]
    area_health: list[dict]
    common_failures: list[dict]
    regression_candidates: list[dict]
    digest_md: str
    artifacts: dict[str, str]


class AnalysisEngine:
    def __init__(
        self,
        store: Optional[HistoryStore] = None,
        db_url: Optional[str] = None,
        ndjson_path: Optional[Path] = None,
    ) -> None:
        self._store = store or make_store(db_url=db_url, ndjson_path=ndjson_path)

    def run(
        self,
        window: int = 30,
        delta: float = 20.0,
        weeks: int = 4,
        min_suites: int = 2,
        min_flake_rate: float = 10.0,
        min_green: int = 5,
        recent_failures: int = 3,
        suite: Optional[str] = None,
    ) -> AnalysisResult:
        from agent.history.detector import detect_regressions

        flaky = self._store.query_flaky(window=window, suite=suite, min_rate=min_flake_rate)

        # For spikes and area health we need run-level data; query_summary gives
        # per-suite aggregate — for cross-suite we query each known suite and pool.
        # When suite is specified, only that suite. Otherwise all suites from the store.
        suites_to_query = [suite] if suite else self._discover_suites()
        spikes_rows: list[dict] = []
        area_rows: list[dict] = []
        for s in suites_to_query:
            summary = self._store.query_summary(suite=s, runs=window * 2)
            spikes_rows.extend(summary.get("runs", []))

        common_rows = self._query_common_failures(suite=suite)

        regression_candidates = self._detect_regressions(
            suite=suite, min_green=min_green, recent_failures=recent_failures
        )

        digest = build_digest(
            flaky=flaky,
            spikes=spikes_rows,
            area_health=area_rows,
            common_failures=common_rows,
            regression_candidates=regression_candidates,
            window=window,
            delta=delta,
            weeks=weeks,
            min_suites=min_suites,
        )

        artifacts = {
            "flaky.md": build_flaky_report(flaky, window=window, min_rate=min_flake_rate),
            "spikes.md": build_spikes_report(spikes_rows, delta=delta),
            "area-health.md": build_area_health_report(area_rows, weeks=weeks),
            "common-failures.md": build_common_failures_report(common_rows, min_suites=min_suites),
            "regression-candidates.md": build_regression_candidates_report(regression_candidates),
            "digest.md": digest,
        }

        return AnalysisResult(
            flaky=flaky,
            spikes=spikes_rows,
            area_health=area_rows,
            common_failures=common_rows,
            regression_candidates=regression_candidates,
            digest_md=digest,
            artifacts=artifacts,
        )

    def _discover_suites(self) -> list[str]:
        # The local store doesn't have a list-suites method; we query summary
        # with an empty suite and extract from whatever runs exist.
        # For the Supabase store a real query would be better; this is
        # good-enough for local use and the Supabase store can override.
        try:
            from agent.history.local_store import LocalHistoryStore
            if isinstance(self._store, LocalHistoryStore):
                records = self._store._read_all()
                return list({r.get("suite", "") for r in records if r.get("suite")})
        except (ImportError, AttributeError):
            pass
        return []

    def _query_common_failures(self, suite: Optional[str]) -> list[dict]:
        # Query failures from test results; local store has all data inline.
        try:
            from agent.history.local_store import LocalHistoryStore
            if isinstance(self._store, LocalHistoryStore):
                records = self._store._read_all()
                rows = []
                for record in records:
                    if suite and record.get("suite") != suite:
                        continue
                    for t in record.get("tests", []):
                        if t.get("status") in ("failed", "flaky") and t.get("error_text"):
                            rows.append({
                                "test_name": t["test_name"],
                                "suite": record.get("suite", ""),
                                "failure_category": t.get("failure_category", "other"),
                                "error_text": t.get("error_text", ""),
                                "run_count": 1,
                            })
                return rows
        except (ImportError, AttributeError):
            pass
        return []

    def _detect_regressions(
        self, suite: Optional[str], min_green: int, recent_failures: int
    ) -> list[dict]:
        from agent.history.detector import detect_regressions
        try:
            from agent.history.local_store import LocalHistoryStore
            if isinstance(self._store, LocalHistoryStore):
                records = self._store._read_all()
                test_names: set[str] = set()
                for record in records:
                    if suite and record.get("suite") != suite:
                        continue
                    for t in record.get("tests", []):
                        test_names.add(t["test_name"])

                candidates = []
                for name in test_names:
                    timeline = self._store.query_timeline(name)
                    result = detect_regressions(timeline, min_green=min_green, recent_failures=recent_failures)
                    if result["is_regression"]:
                        candidates.append({
                            "test_name": name,
                            "suite": timeline[0].get("suite", "") if timeline else "",
                            "area": None,
                            "green_streak": result["green_streak"],
                            "first_failure_commit": result["first_failure_commit"],
                            "recent_failures": recent_failures,
                        })
                return candidates
        except (ImportError, AttributeError):
            pass
        return []
