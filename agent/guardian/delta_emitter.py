"""Emit the machine-readable api-delta.json v1 artifact.

Serializes an ApiDiff into the frozen contract (docs/specs/api-delta-contract.md)
that downstream tooling consumes to trigger library-stub regeneration. Generic
and company-neutral — the shape carries only HTTP method/path/change categories.

The builder is pure (the caller supplies `generated`) so it stays testable.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.guardian.diff_extractor import ApiDiff, classify_changes


def build_api_delta(diff: ApiDiff, sha: str, suite: str, generated: str) -> dict:
    """Build the api-delta.json v1 dict from an ApiDiff."""
    return {
        "schema_version": 1,
        "sut": {"sha": sha, "suite": suite},
        "generated": generated,
        "summary": {
            "added": len(diff.added),
            "removed": len(diff.removed),
            "changed": len(diff.changed),
            "total": len(diff.added) + len(diff.removed) + len(diff.changed),
        },
        "endpoints": {
            "added": [{"method": ec.method.upper(), "path": ec.path} for ec in diff.added],
            "removed": [{"method": ec.method.upper(), "path": ec.path} for ec in diff.removed],
            "changed": [
                {
                    "method": ec.method.upper(),
                    "path": ec.path,
                    "changes": classify_changes(ec.before, ec.after),
                }
                for ec in diff.changed
            ],
        },
    }


def write_api_delta(delta: dict, path: str) -> None:
    """Write the api-delta dict to `path` as indented JSON."""
    Path(path).write_text(json.dumps(delta, indent=2) + "\n", encoding="utf-8")
