"""Abstract HistoryStore interface and factory.

The factory checks for CANARY_HISTORY_DB_URL (env var) then company.json
and returns a SupabaseHistoryStore when configured, LocalHistoryStore otherwise.
Push failure in the Supabase store is non-fatal — callers always get a result.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from agent.history.schema import RunRecord, TestResult


class HistoryStore(ABC):
    @abstractmethod
    def push_run(self, run: RunRecord, results: list[TestResult]) -> None: ...

    @abstractmethod
    def query_flaky(
        self,
        window: int,
        suite: Optional[str],
        min_rate: float,
    ) -> list[dict]: ...

    @abstractmethod
    def query_timeline(self, test_name: str) -> list[dict]: ...

    @abstractmethod
    def query_summary(self, suite: str, runs: int) -> dict: ...


def make_store(
    db_url: Optional[str] = None,
    ndjson_path: Optional[Path] = None,
) -> HistoryStore:
    resolved_url = db_url or os.environ.get("CANARY_HISTORY_DB_URL")

    if resolved_url:
        try:
            from agent.history.supabase_store import SupabaseHistoryStore
            return SupabaseHistoryStore(resolved_url)
        except ImportError:
            pass

    from agent.history.local_store import LocalHistoryStore
    path = ndjson_path or Path("test-results/reports/history-v2.jsonl")
    return LocalHistoryStore(path)
