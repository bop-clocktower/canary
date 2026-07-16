"""Dataclasses for the run.json v1 contract (trace-only).

RunArtifact.to_dict() is a plain dataclasses.asdict() call — the JSON shape
on disk is the dataclass shape, field-for-field. No `coverage` key and no
`canary_run_id` key exist anywhere in this module: both were cut for v1
(see docs/changes/canary-instrument/proposal.md — coverage is a separate
future skill; canary_run_id has no consumer yet). Additive-only evolution:
new optional fields may be appended later; existing fields never change
meaning.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class RequestSpan:
    method: str
    url: str
    route: Optional[str]
    status: Optional[int]
    duration_ms: float
    span_id: str
    started_at: str


@dataclass
class TestTrace:
    test_id: str  # "__setup__" for orphan (rootless) traffic
    test_title: str
    test_file: str
    trace_id: str
    outcome: str
    requests: List[RequestSpan] = field(default_factory=list)


@dataclass
class Trace:
    spans_total: int
    by_test: List[TestTrace] = field(default_factory=list)


@dataclass
class RunArtifact:
    schema_version: int
    suite_type: str
    generated_at: str
    trace: Trace

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
