"""Data classes for run history records.

Run IDs use the pattern {suite}-{commit[:8]}-{epoch} for human readability
and uniqueness. This is cheaper than UUIDs for humans to scan in logs and the
NDJSON fallback, while still being effectively collision-free within a suite.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


def make_run_id(suite: str, commit_sha: str, timestamp_epoch: int) -> str:
    return f"{suite}-{commit_sha[:8]}-{timestamp_epoch}"


@dataclass
class RunRecord:
    run_id: str
    suite: str
    repo: str
    branch: str
    commit_sha: str
    timestamp: str
    total: int
    passed: int
    failed: int
    flaky: int
    skipped: int
    commit_message: Optional[str] = None
    env: Optional[str] = None
    base_url: Optional[str] = None
    duration_ms: Optional[int] = None


@dataclass
class TestResult:
    run_id: str
    suite: str
    repo: str
    test_name: str
    test_file: str
    status: str
    area: Optional[str] = None
    failure_category: Optional[str] = None
    error_text: Optional[str] = None
    retry_count: int = 0
    duration_ms: Optional[int] = None
    tags: list = field(default_factory=list)
