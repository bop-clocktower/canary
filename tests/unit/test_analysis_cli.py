"""CliRunner coverage for `canary analyze` subcommands.

Fix #4 of issue #299: the analyze subapp (agent/analysis/cli.py) had no
CLI-level coverage. These tests drive each subcommand against a seeded
local history store (via a temp cwd so make_store resolves its default
path) and assert both the human-readable and --json output paths, plus
the empty-store degradation.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from typer.testing import CliRunner

from agent.cli import app

_HISTORY_REL = Path("test-results/reports/history-v2.jsonl")


@contextlib.contextmanager
def _seeded_cwd(seed: bool = True):
    """Temp cwd containing (optionally) a seeded history-v2.jsonl."""
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        if seed:
            path = Path(tmp) / _HISTORY_REL
            path.parent.mkdir(parents=True, exist_ok=True)
            record = {
                "run_id": "r1",
                "suite": "checkout",
                "timestamp": "2026-07-02T00:00:00Z",
                "passed": 1,
                "failed": 1,
                "flaky": 1,
                "total": 3,
                "commit_sha": "aaa",
                "tests": [
                    {"test_name": "test_ok", "status": "passed"},
                    {
                        "test_name": "test_pay",
                        "status": "failed",
                        "failure_category": "assertion",
                        "error_text": "AssertionError: boom",
                    },
                    {
                        "test_name": "test_flaky",
                        "status": "flaky",
                        "failure_category": "timeout",
                        "error_text": "TimeoutError",
                    },
                ],
            }
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")
        try:
            yield Path(tmp)
        finally:
            os.chdir(prev)


class TestAnalyzeCli(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_flaky_json_output(self):
        with _seeded_cwd():
            result = self.runner.invoke(app, ["analyze", "flaky", "--json", "--min-rate", "0"])
        self.assertEqual(result.exit_code, 0, result.output)
        # Valid JSON array.
        json.loads(result.output)

    def test_flaky_human_output(self):
        with _seeded_cwd():
            result = self.runner.invoke(app, ["analyze", "flaky", "--min-rate", "0"])
        self.assertEqual(result.exit_code, 0, result.output)

    def test_spikes_json_output(self):
        with _seeded_cwd():
            result = self.runner.invoke(app, ["analyze", "spikes", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        json.loads(result.output)

    def test_common_failures_json_lists_failures(self):
        with _seeded_cwd():
            result = self.runner.invoke(app, ["analyze", "common-failures", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        rows = json.loads(result.output)
        self.assertTrue(any(r["test_name"] == "test_pay" for r in rows))

    def test_regression_candidates_json_output(self):
        with _seeded_cwd():
            result = self.runner.invoke(app, ["analyze", "regression-candidates", "--json"])
        self.assertEqual(result.exit_code, 0, result.output)
        json.loads(result.output)

    def test_digest_writes_artifacts_and_json_counts(self):
        with _seeded_cwd() as cwd:
            result = self.runner.invoke(
                app, ["analyze", "digest", "--json", "--output", "out-dir"]
            )
            self.assertEqual(result.exit_code, 0, result.output)
            payload = json.loads(result.output)
            self.assertIn("flaky_count", payload)
            self.assertTrue((cwd / "out-dir" / "digest.md").exists())

    def test_digest_on_empty_store_does_not_crash(self):
        with _seeded_cwd(seed=False):
            result = self.runner.invoke(app, ["analyze", "digest", "--output", "out-dir"])
        self.assertEqual(result.exit_code, 0, result.output)


if __name__ == "__main__":
    unittest.main()
