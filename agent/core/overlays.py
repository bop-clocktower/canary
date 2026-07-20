"""Resolve tracked overlays for ``canary migrate --from``.

Tracked overlays are git clones under ``~/.canary/overlays/<name>/`` created by
``canary overlay add`` (the TypeScript shim). This module maps a ``--from``
value to a clone path.

Cross-runtime contract (matches the Phase 1 skill loader,
``skill_registry._overlay_skills``): the clone **directories** are the source of
truth. ``overlays.json`` is written solely by the TS side and is read here
**only** to order overlay names when it parses — its absence or corruption never
blocks resolution (a directory scan is the fallback).

Disambiguation: a value containing a path separator (``./o``, ``../o``,
``/abs/o``) is a **path**; a bare token (``example-org-example-overlay``) is an
overlay **name**. A bare token is never treated as a path, so a same-named
directory in the current working directory cannot shadow a tracked overlay, and
a mistyped name fails loudly instead of silently resolving to a stray path.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


class OverlayNotFound(Exception):
    """A ``--from`` value did not resolve to an overlay (bad name or missing path)."""

    def __init__(self, name: str, available: list[str]) -> None:
        self.name = name
        self.available = available
        if available:
            hint = "tracked overlays: " + ", ".join(available)
        else:
            hint = "no overlays are tracked — add one with `canary overlay add <source>`"
        super().__init__(f"could not resolve overlay '{name}' ({hint})")


def _overlays_root(home: Path) -> Path:
    return home / ".canary" / "overlays"


def _registry_order(home: Path) -> list[str]:
    """Overlay names in ``overlays.json`` order, or ``[]`` when it is unreadable."""
    registry = home / ".canary" / "overlays.json"
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
        overlays = data["overlays"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    if not isinstance(overlays, list):
        return []
    return [o["name"] for o in overlays if isinstance(o, dict) and isinstance(o.get("name"), str)]


def registry_precedence(home: Path) -> dict[str, int]:
    """Map overlay name -> declared precedence from ``overlays.json`` (#333).

    A null/absent/non-numeric precedence is 0. An unreadable or malformed
    registry yields an empty map, so callers fall back to directory-name order.
    Higher precedence wins a skill-name collision — the winner rule mirrors the
    TS side (``npm/src/overlay-conflicts.ts``) so both runtimes agree.
    """
    registry = home / ".canary" / "overlays.json"
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
        overlays = data["overlays"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if not isinstance(overlays, list):
        return {}
    result: dict[str, int] = {}
    for o in overlays:
        if not isinstance(o, dict) or not isinstance(o.get("name"), str):
            continue
        p = o.get("precedence")
        result[o["name"]] = p if isinstance(p, (int, float)) and not isinstance(p, bool) else 0
    return result


def list_overlays(home: Path | None = None) -> list[str]:
    """Names of tracked overlays (clone dirs under ``~/.canary/overlays/``).

    Ordered by ``overlays.json`` when it parses (on-disk overlays not listed
    there are appended in sorted order); otherwise a plain sorted directory
    scan. Returns ``[]`` when no overlays root exists.
    """
    home = home or Path.home()
    root = _overlays_root(home)
    if not root.is_dir():
        return []
    on_disk = {entry.name for entry in root.iterdir() if entry.is_dir()}
    ordered = [name for name in _registry_order(home) if name in on_disk]
    extras = sorted(on_disk.difference(ordered))
    return ordered + extras


def resolve_overlay(name_or_path: str, home: Path | None = None) -> Path:
    """Resolve a ``--from`` value to an overlay clone path.

    A value with a path separator is resolved as a path (which must exist). A
    bare token is looked up as a tracked-overlay name under
    ``~/.canary/overlays/``. Either miss raises :class:`OverlayNotFound` carrying
    the available names.
    """
    home = home or Path.home()
    if _looks_like_path(name_or_path):
        candidate = Path(name_or_path)
        if candidate.exists():
            return candidate.resolve()
        raise OverlayNotFound(name_or_path, list_overlays(home))
    candidate = _overlays_root(home) / name_or_path
    if candidate.is_dir():
        return candidate.resolve()
    raise OverlayNotFound(name_or_path, list_overlays(home))


def _looks_like_path(value: str) -> bool:
    separators = {os.sep}
    if os.altsep:
        separators.add(os.altsep)
    return any(sep in value for sep in separators)
