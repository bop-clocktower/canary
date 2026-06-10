"""Tests for agent/history/local_store.py — NDJSON-backed HistoryStore."""

from __future__ import annotations

import json
import pytest
from pathlib import Path

from agent.history.schema import RunRecord, TestResult
from agent.history.local_store import LocalHistoryStore


def _run(run_id: str, suite: str = "api", branch: str = "main",
         passed: int = 9, failed: int = 1, flaky: int = 0) -> RunRecord:
    return RunRecord(
        run_id=run_id,
        suite=suite,
        repo="acme-corp/api-service",
        branch=branch,
        commit_sha="abc1234567890",
        timestamp="2026-06-09T16:00:00Z",
        total=passed + failed + flaky,
        passed=passed,
        failed=failed,
        flaky=flaky,
        skipped=0,
    )


def _result(run_id: str, test_name: str, status: str = "passed",
            area: str = "members", suite: str = "api",
            failure_category: str | None = None,
            error_text: str | None = None,
            retry_count: int = 0) -> TestResult:
    return TestResult(
        run_id=run_id,
        suite=suite,
        repo="acme-corp/api-service",
        test_name=test_name,
        test_file=f"tests/{area}/test.spec.ts",
        status=status,
        area=area,
        failure_category=failure_category,
        error_text=error_text,
        retry_count=retry_count,
    )


class TestLocalHistoryStorePush:
    def test_push_creates_file(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        run = _run("api-abc12345-001")
        store.push_run(run, [])
        assert (tmp_path / "history.jsonl").exists()

    def test_push_appends_run_as_single_line(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        run = _run("api-abc12345-001")
        store.push_run(run, [])
        lines = (tmp_path / "history.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1
        data = json.loads(lines[0])
        assert data["run_id"] == "api-abc12345-001"

    def test_push_embeds_test_results(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        run = _run("api-abc12345-001")
        results = [
            _result("api-abc12345-001", "test A", "passed"),
            _result("api-abc12345-001", "test B", "failed"),
        ]
        store.push_run(run, results)
        data = json.loads((tmp_path / "history.jsonl").read_text().strip())
        assert len(data["tests"]) == 2
        assert data["tests"][0]["test_name"] == "test A"

    def test_push_multiple_runs_appends(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        store.push_run(_run("api-abc12345-001"), [])
        store.push_run(_run("api-abc12345-002"), [])
        lines = (tmp_path / "history.jsonl").read_text().strip().splitlines()
        assert len(lines) == 2

    def test_push_creates_parent_dirs(self, tmp_path):
        path = tmp_path / "deep" / "nested" / "history.jsonl"
        store = LocalHistoryStore(path)
        store.push_run(_run("api-abc12345-001"), [])
        assert path.exists()

    def test_push_duplicate_run_id_is_idempotent(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        run = _run("api-abc12345-001")
        store.push_run(run, [])
        store.push_run(run, [])
        lines = (tmp_path / "history.jsonl").read_text().strip().splitlines()
        assert len(lines) == 1


class TestLocalHistoryStoreQueryFlaky:
    def _store_with_runs(self, tmp_path, runs_and_results):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        for run, results in runs_and_results:
            store.push_run(run, results)
        return store

    def test_returns_empty_when_no_runs(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        result = store.query_flaky(window=30, suite=None, min_rate=10.0)
        assert result == []

    def test_detects_flaky_test(self, tmp_path):
        runs = [
            (_run(f"api-abc-00{i}"), [_result(f"api-abc-00{i}", "test A", "flaky" if i < 4 else "passed")])
            for i in range(10)
        ]
        store = self._store_with_runs(tmp_path, runs)
        flakeys = store.query_flaky(window=10, suite=None, min_rate=30.0)
        assert any(f["test_name"] == "test A" for f in flakeys)

    def test_excludes_below_min_rate(self, tmp_path):
        # test A flaky 1/10 = 10%, filter at 20%
        runs = [
            (_run(f"api-abc-00{i}"), [_result(f"api-abc-00{i}", "test A", "flaky" if i == 0 else "passed")])
            for i in range(10)
        ]
        store = self._store_with_runs(tmp_path, runs)
        flakeys = store.query_flaky(window=10, suite=None, min_rate=20.0)
        assert flakeys == []

    def test_filters_by_suite(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        for i in range(5):
            store.push_run(_run(f"api-abc-00{i}", suite="api"),
                           [_result(f"api-abc-00{i}", "test A", "flaky", suite="api")])
            store.push_run(_run(f"e2e-abc-00{i}", suite="e2e_ui"),
                           [_result(f"e2e-abc-00{i}", "test A", "passed", suite="e2e_ui")])
        flakeys = store.query_flaky(window=10, suite="e2e_ui", min_rate=10.0)
        assert flakeys == []

    def test_flaky_summary_includes_rate(self, tmp_path):
        runs = [
            (_run(f"api-abc-00{i}"), [_result(f"api-abc-00{i}", "test A", "flaky" if i < 3 else "passed")])
            for i in range(10)
        ]
        store = self._store_with_runs(tmp_path, runs)
        flakeys = store.query_flaky(window=10, suite=None, min_rate=10.0)
        match = next(f for f in flakeys if f["test_name"] == "test A")
        assert match["flake_rate_pct"] == 30.0
        assert match["flake_count"] == 3
        assert match["total_runs"] == 10


class TestLocalHistoryStoreQueryTimeline:
    def test_returns_empty_for_unknown_test(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        assert store.query_timeline("no such test") == []

    def test_returns_results_in_chronological_order(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        for i in range(3):
            run = RunRecord(
                run_id=f"api-abc-00{i}",
                suite="api",
                repo="acme-corp/api-service",
                branch="main",
                commit_sha=f"abc{i}",
                timestamp=f"2026-06-0{i+1}T16:00:00Z",
                total=1, passed=1, failed=0, flaky=0, skipped=0,
            )
            store.push_run(run, [_result(f"api-abc-00{i}", "test A", "passed")])
        timeline = store.query_timeline("test A")
        assert len(timeline) == 3
        assert timeline[0]["run_id"] == "api-abc-000"
        assert timeline[2]["run_id"] == "api-abc-002"

    def test_includes_status_and_commit(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        run = RunRecord(
            run_id="api-abc12345-001",
            suite="api",
            repo="acme-corp/api-service",
            branch="main",
            commit_sha="abc1234567890",
            timestamp="2026-06-09T16:00:00Z",
            total=1, passed=0, failed=1, flaky=0, skipped=0,
        )
        store.push_run(run, [_result("api-abc12345-001", "test A", "failed")])
        timeline = store.query_timeline("test A")
        row = timeline[0]
        assert row["status"] == "failed"
        assert row["commit_sha"] == "abc1234567890"


class TestLocalHistoryStoreQuerySummary:
    def test_summary_counts(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        for i in range(5):
            store.push_run(_run(f"api-abc-00{i}", passed=8, failed=2), [])
        summary = store.query_summary(suite="api", runs=5)
        assert summary["total_runs"] == 5
        assert summary["avg_pass_rate"] == 80.0

    def test_summary_limited_to_n_most_recent(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        for i in range(10):
            store.push_run(_run(f"api-abc-0{i:02d}", passed=9, failed=1), [])
        summary = store.query_summary(suite="api", runs=3)
        assert summary["total_runs"] == 3

    def test_summary_returns_zero_for_empty(self, tmp_path):
        store = LocalHistoryStore(tmp_path / "history.jsonl")
        summary = store.query_summary(suite="api", runs=10)
        assert summary["total_runs"] == 0
