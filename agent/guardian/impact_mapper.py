"""Map an ApiDiff against test coverage rows to produce impact gaps.

Coverage rows come from canary coverage (coverage-report.json) — each row
identifies which test exercises which endpoint.

Severity rules:
  CRITICAL — removed endpoint with existing tests (tests will break)
  HIGH     — added endpoint with no coverage (gap), or changed with no coverage
  MEDIUM   — changed endpoint with existing tests (silent contract drift risk)
  LOW      — added endpoint that already has coverage (rare, e.g. shared fixtures)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from agent.guardian.diff_extractor import ApiDiff, ChangeType


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

    @property
    def sort_key(self) -> int:
        return {"critical": 0, "high": 1, "medium": 2, "low": 3}[self.value]


@dataclass
class ImpactGap:
    path: str
    method: str
    operation_id: str
    change_type: ChangeType
    severity: Severity
    affected_tests: list[str] = field(default_factory=list)


def _normalize_path(path: str) -> str:
    """Normalize path parameter syntax for matching.

    Converts both `:id` and `{id}` forms to `{id}` so coverage rows
    and OpenAPI paths match regardless of which convention is used.
    """
    import re
    return re.sub(r":([a-zA-Z_][a-zA-Z0-9_]*)", r"{\1}", path)


def map_impact(diff: ApiDiff, coverage_rows: list[dict]) -> list[ImpactGap]:
    """Map diff changes to test impact gaps, sorted by severity."""
    # Build a lookup: normalized_path+method → list of test_names
    coverage: dict[tuple[str, str], list[str]] = {}
    for row in coverage_rows:
        key = (_normalize_path(row["path"]), row["method"].lower())
        coverage.setdefault(key, []).append(row["test_name"])

    gaps: list[ImpactGap] = []

    for change in diff.removed:
        key = (_normalize_path(change.path), change.method.lower())
        tests = coverage.get(key, [])
        gaps.append(ImpactGap(
            path=change.path,
            method=change.method,
            operation_id=change.operation_id,
            change_type=ChangeType.REMOVED,
            severity=Severity.CRITICAL if tests else Severity.HIGH,
            affected_tests=tests,
        ))

    for change in diff.added:
        key = (_normalize_path(change.path), change.method.lower())
        tests = coverage.get(key, [])
        gaps.append(ImpactGap(
            path=change.path,
            method=change.method,
            operation_id=change.operation_id,
            change_type=ChangeType.ADDED,
            severity=Severity.LOW if tests else Severity.HIGH,
            affected_tests=tests,
        ))

    for change in diff.changed:
        key = (_normalize_path(change.path), change.method.lower())
        tests = coverage.get(key, [])
        gaps.append(ImpactGap(
            path=change.path,
            method=change.method,
            operation_id=change.operation_id,
            change_type=ChangeType.CHANGED,
            severity=Severity.MEDIUM if tests else Severity.HIGH,
            affected_tests=tests,
        ))

    return sorted(gaps, key=lambda g: g.severity.sort_key)
