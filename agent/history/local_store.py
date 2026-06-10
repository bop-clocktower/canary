"""Local NDJSON-backed HistoryStore.

Each line is a JSON object containing a RunRecord plus its embedded TestResults:
  {"run_id": "...", "suite": "...", ..., "tests": [...]}

This is the offline fallback and the migration source for the Supabase store.
Duplicate run_ids are silently ignored (idempotent push).
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from agent.history.schema import RunRecord, TestResult
from agent.history.store import HistoryStore


class LocalHistoryStore(HistoryStore):
    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def _read_all(self) -> list[dict]:
        if not self._path.exists():
            return []
        try:
            records = []
            for line in self._path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    records.append(json.loads(line))
            return records
        except (OSError, json.JSONDecodeError):
            return []

    def push_run(self, run: RunRecord, results: list[TestResult]) -> None:
        existing = self._read_all()
        existing_ids = {r["run_id"] for r in existing}
        if run.run_id in existing_ids:
            return

        record = asdict(run)
        record["tests"] = [asdict(t) for t in results]

        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    def query_flaky(
        self,
        window: int,
        suite: Optional[str],
        min_rate: float,
    ) -> list[dict]:
        records = self._read_all()
        if suite:
            records = [r for r in records if r.get("suite") == suite]
        records = records[-window:]

        # Aggregate flake counts per test_name
        counts: dict[str, dict] = {}
        for record in records:
            for t in record.get("tests", []):
                name = t["test_name"]
                if name not in counts:
                    counts[name] = {
                        "test_name": name,
                        "test_file": t.get("test_file", ""),
                        "suite": t.get("suite", record.get("suite", "")),
                        "area": t.get("area"),
                        "flake_count": 0,
                        "pass_count": 0,
                        "fail_count": 0,
                        "total_runs": 0,
                        "last_seen_run": None,
                    }
                counts[name]["total_runs"] += 1
                status = t.get("status", "")
                if status == "flaky":
                    counts[name]["flake_count"] += 1
                elif status == "passed":
                    counts[name]["pass_count"] += 1
                elif status == "failed":
                    counts[name]["fail_count"] += 1
                counts[name]["last_seen_run"] = record["run_id"]

        results = []
        for name, c in counts.items():
            if c["total_runs"] == 0:
                continue
            rate = round(c["flake_count"] / c["total_runs"] * 100, 1)
            if rate >= min_rate:
                results.append({**c, "flake_rate_pct": rate})

        return sorted(results, key=lambda x: x["flake_rate_pct"], reverse=True)

    def query_timeline(self, test_name: str) -> list[dict]:
        records = self._read_all()
        timeline = []
        for record in records:
            for t in record.get("tests", []):
                if t["test_name"] == test_name:
                    timeline.append({
                        "run_id": record["run_id"],
                        "suite": record.get("suite", ""),
                        "branch": record.get("branch", ""),
                        "commit_sha": record.get("commit_sha", ""),
                        "timestamp": record.get("timestamp", ""),
                        "status": t.get("status", ""),
                        "failure_category": t.get("failure_category"),
                        "error_text": t.get("error_text"),
                        "retry_count": t.get("retry_count", 0),
                    })
        return sorted(timeline, key=lambda x: x["timestamp"])

    def query_summary(self, suite: str, runs: int) -> dict:
        records = self._read_all()
        suite_records = [r for r in records if r.get("suite") == suite]
        recent = suite_records[-runs:] if runs > 0 else suite_records
        if not recent:
            return {"suite": suite, "total_runs": 0, "avg_pass_rate": 0.0}

        rates = []
        for r in recent:
            total = r.get("total", 0)
            passed = r.get("passed", 0)
            if total > 0:
                rates.append(passed / total * 100)

        avg = round(sum(rates) / len(rates), 1) if rates else 0.0
        return {
            "suite": suite,
            "total_runs": len(recent),
            "avg_pass_rate": avg,
            "runs": [
                {
                    "run_id": r["run_id"],
                    "branch": r.get("branch", ""),
                    "timestamp": r.get("timestamp", ""),
                    "passed": r.get("passed", 0),
                    "failed": r.get("failed", 0),
                    "flaky": r.get("flaky", 0),
                    "total": r.get("total", 0),
                }
                for r in recent
            ],
        }
