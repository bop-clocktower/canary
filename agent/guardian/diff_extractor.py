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
