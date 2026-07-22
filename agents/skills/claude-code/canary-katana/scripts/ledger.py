#!/usr/bin/env python3
"""ledger -- the append-only quarantine record for deleted/skipped tests.

Every captured deletion is written with its provenance (who, when, what commit,
why) so a test that vanishes leaves a trail instead of a silent gap. The ledger
is append-only and de-duplicated: re-running the capture on the same change adds
nothing, and a batch of new entries is sorted for a stable on-disk order.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

SCHEMA_VERSION = 1

# The fields, in the order they define a row's identity for de-duplication.
_FIELDS = ("test", "file", "kind", "marker", "commit", "author", "date", "reason")


@dataclass
class LedgerEntry:
    test: str
    file: str
    kind: str
    marker: str
    commit: str
    author: str
    date: str
    reason: str

    def to_row(self) -> dict:
        return {field: getattr(self, field) for field in _FIELDS}


def _key(row: dict) -> tuple:
    return tuple(row.get(field, "") for field in _FIELDS)


def load(path: Path) -> dict:
    """Load the ledger document, or an empty one when the file is absent.

    Raises ValueError on unparseable JSON or a non-object top level -- a
    corrupt ledger is a hard error the caller must surface, not silently
    overwrite.
    """
    path = Path(path)
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "entries": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"ledger is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"ledger top level must be an object: {path}")
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("entries", [])
    return data


def append_entries(path: Path, entries: list[LedgerEntry]) -> dict:
    """Append ``entries`` to the ledger at ``path`` and persist it.

    New entries are sorted by (file, test) for a stable order and de-duplicated
    against both the batch and what is already on disk. Existing entries keep
    their position -- the ledger only ever grows.
    """
    path = Path(path)
    doc = load(path)
    existing = doc["entries"]
    seen = {_key(row) for row in existing}

    new_rows = sorted((e.to_row() for e in entries), key=lambda r: (r["file"], r["test"]))
    for row in new_rows:
        key = _key(row)
        if key in seen:
            continue
        seen.add(key)
        existing.append(row)

    doc["schema_version"] = SCHEMA_VERSION
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    return doc
