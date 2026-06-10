"""Run history store — shared Supabase-backed ledger for cross-suite analytics."""

from agent.history.schema import RunRecord, TestResult, make_run_id
from agent.history.store import HistoryStore, make_store
from agent.history.local_store import LocalHistoryStore

__all__ = [
    "RunRecord",
    "TestResult",
    "make_run_id",
    "HistoryStore",
    "LocalHistoryStore",
    "make_store",
]
