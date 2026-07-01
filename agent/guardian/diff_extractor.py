"""OpenAPI spec diff extractor.

Compares two OpenAPI specs (before/after a commit) and produces a structured
list of added, removed, and changed endpoints.

Input: parsed dicts (from json.loads or yaml.safe_load).
Output: ApiDiff dataclass with three lists of EndpointChange.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ChangeType(str, Enum):
    ADDED = "added"
    REMOVED = "removed"
    CHANGED = "changed"


@dataclass
class EndpointChange:
    path: str
    method: str
    change_type: ChangeType
    operation_id: str = ""
    summary: str = ""
    before: dict = field(default_factory=dict)
    after: dict = field(default_factory=dict)


@dataclass
class ApiDiff:
    added: list[EndpointChange]
    removed: list[EndpointChange]
    changed: list[EndpointChange]

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed or self.changed)


_HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

# Frozen vocabulary for a changed endpoint (see docs/specs/api-delta-contract.md).
VALID_CHANGES = ("params", "request-body", "response", "auth", "status-codes")


def classify_changes(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Classify a changed OpenAPI operation into the frozen change vocabulary.

    Returns every applicable category (an operation may change in several ways
    at once), ordered by ``VALID_CHANGES`` for stable output. A change confined
    to non-contract fields (summary/description/tags) returns an empty list.
    """
    found: set[str] = set()

    if (before.get("parameters") or []) != (after.get("parameters") or []):
        found.add("params")
    if before.get("requestBody") != after.get("requestBody"):
        found.add("request-body")
    if before.get("security") != after.get("security"):
        found.add("auth")

    before_resp = before.get("responses") or {}
    after_resp = after.get("responses") or {}
    if set(before_resp) != set(after_resp):
        found.add("status-codes")
    for code in set(before_resp) & set(after_resp):
        if before_resp[code] != after_resp[code]:
            found.add("response")
            break

    return [c for c in VALID_CHANGES if c in found]


def _iter_operations(spec: dict[str, Any]):
    for path, path_item in (spec.get("paths") or {}).items():
        for method in _HTTP_METHODS:
            op = path_item.get(method)
            if op:
                yield path, method, op


def extract_api_diff(before: dict[str, Any], after: dict[str, Any]) -> ApiDiff:
    """Compare two OpenAPI spec dicts and return the diff."""
    before_ops: dict[tuple[str, str], dict] = {
        (path, method): op for path, method, op in _iter_operations(before)
    }
    after_ops: dict[tuple[str, str], dict] = {
        (path, method): op for path, method, op in _iter_operations(after)
    }

    added: list[EndpointChange] = []
    removed: list[EndpointChange] = []
    changed: list[EndpointChange] = []

    for (path, method), op in after_ops.items():
        if (path, method) not in before_ops:
            added.append(EndpointChange(
                path=path,
                method=method,
                change_type=ChangeType.ADDED,
                operation_id=op.get("operationId", ""),
                summary=op.get("summary", ""),
                after=op,
            ))
        else:
            before_op = before_ops[(path, method)]
            if op != before_op:
                changed.append(EndpointChange(
                    path=path,
                    method=method,
                    change_type=ChangeType.CHANGED,
                    operation_id=op.get("operationId", before_op.get("operationId", "")),
                    summary=op.get("summary", ""),
                    before=before_op,
                    after=op,
                ))

    for (path, method), op in before_ops.items():
        if (path, method) not in after_ops:
            removed.append(EndpointChange(
                path=path,
                method=method,
                change_type=ChangeType.REMOVED,
                operation_id=op.get("operationId", ""),
                summary=op.get("summary", ""),
                before=op,
            ))

    return ApiDiff(added=added, removed=removed, changed=changed)
