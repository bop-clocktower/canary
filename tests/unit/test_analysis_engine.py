"""Coverage for agent.analysis.engine.AnalysisEngine.

Fix #4 of issue #299: the engine coordinates the history store and the
report builders, with several branches that swallow ImportError /
AttributeError while probing the concrete store type (engine.py ~line
116, 140, 173). These tests drive the engine against a real
LocalHistoryStore populated with a small fixture, and against a
non-local store, so both the populated path and the swallow/fall-through
path are exercised.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.analysis.engine import AnalysisEngine, AnalysisResult
from agent.history.local_store import LocalHistoryStore


def _seed_store(path: Path) -> LocalHistoryStore:
    """Write two runs of a suite with one always-failing test."""
    records = [
        {
            "run_id": "r1",
            "suite": "checkout",
            "timestamp": "2026-07-01T00:00:00Z",
            "passed": 1,
            "failed": 1,
            "flaky": 0,
            "total": 2,
            "commit_sha": "aaa",
            "tests": [
                {"test_name": "test_ok", "status": "passed"},
                {
                    "test_name": "test_pay",
                    "status": "failed",
                    "failure_category": "assertion",
                    "error_text": "AssertionError: expected 200",
                },
            ],
        },
        {
            "run_id": "r2",
            "suite": "checkout",
            "timestamp": "2026-07-02T00:00:00Z",
            "passed": 1,
            "failed": 1,
            "flaky": 0,
            "total": 2,
            "commit_sha": "bbb",
            "tests": [
                {"test_name": "test_ok", "status": "passed"},
                {
                    "test_name": "test_pay",
                    "status": "failed",
                    "failure_category": "assertion",
                    "error_text": "AssertionError: expected 200",
                },
            ],
        },
    ]
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
    return LocalHistoryStore(path)


class TestAnalysisEngineRun(unittest.TestCase):
    def test_run_returns_analysis_result_with_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _seed_store(Path(tmp) / "history.jsonl")
            engine = AnalysisEngine(store=store)
            result = engine.run(window=10)
        self.assertIsInstance(result, AnalysisResult)
        self.assertIn("digest.md", result.artifacts)
        self.assertIn("flaky.md", result.artifacts)

    def test_discover_suites_finds_seeded_suite(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _seed_store(Path(tmp) / "history.jsonl")
            engine = AnalysisEngine(store=store)
            self.assertIn("checkout", engine._discover_suites())

    def test_run_spikes_rows_carry_suite_key(self):
        """Regression: query_summary run rows omit 'suite', but the spikes
        builder groups by it — engine.run() must tag each pooled row so a
        populated store doesn't KeyError."""
        with tempfile.TemporaryDirectory() as tmp:
            store = _seed_store(Path(tmp) / "history.jsonl")
            engine = AnalysisEngine(store=store)
            result = engine.run(window=10)
        self.assertTrue(result.spikes, "expected pooled run rows")
        self.assertTrue(all("suite" in row for row in result.spikes))

    def test_common_failures_extracted_from_failed_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _seed_store(Path(tmp) / "history.jsonl")
            engine = AnalysisEngine(store=store)
            rows = engine._query_common_failures(suite=None)
        self.assertTrue(any(r["test_name"] == "test_pay" for r in rows))

    def test_common_failures_respects_suite_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _seed_store(Path(tmp) / "history.jsonl")
            engine = AnalysisEngine(store=store)
            rows = engine._query_common_failures(suite="nonexistent-suite")
        self.assertEqual(rows, [])


class TestAnalysisEngineNonLocalStore(unittest.TestCase):
    """A store that is not a LocalHistoryStore must fall through the
    isinstance guards cleanly (empty results), never raise."""

    class _StubStore:
        def query_flaky(self, window, suite, min_rate):
            return []

        def query_summary(self, suite, runs):
            return {"runs": []}

        def query_timeline(self, test_name):
            return []

    def test_discover_suites_empty_for_non_local_store(self):
        engine = AnalysisEngine(store=self._StubStore())
        self.assertEqual(engine._discover_suites(), [])

    def test_common_failures_empty_for_non_local_store(self):
        engine = AnalysisEngine(store=self._StubStore())
        self.assertEqual(engine._query_common_failures(suite=None), [])

    def test_detect_regressions_empty_for_non_local_store(self):
        engine = AnalysisEngine(store=self._StubStore())
        self.assertEqual(
            engine._detect_regressions(suite=None, min_green=5, recent_failures=3),
            [],
        )

    def test_run_does_not_raise_for_non_local_store(self):
        engine = AnalysisEngine(store=self._StubStore())
        result = engine.run(window=5)
        self.assertIsInstance(result, AnalysisResult)


if __name__ == "__main__":
    unittest.main()
