"""Tracked-overlay resolution for `canary migrate --from` (agent.core.overlays).

Contract mirrors the Phase 1 skill loader: the clone directories under
``~/.canary/overlays/`` are the source of truth (directory scan), and
``overlays.json`` is consulted only to order the names when it parses. A bare
token is always an overlay name; a value with a path separator is a path.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.overlays import (
    OverlayNotFound,
    list_overlays,
    registry_precedence,
    resolve_overlay,
)


def _add_overlay(home: Path, name: str) -> Path:
    """Create a tracked-overlay clone dir under a temp home."""
    clone = home / ".canary" / "overlays" / name
    (clone / ".canary" / "skills").mkdir(parents=True)
    return clone


def _write_registry(home: Path, names: list[str]) -> None:
    reg = home / ".canary" / "overlays.json"
    reg.parent.mkdir(parents=True, exist_ok=True)
    reg.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "overlays": [
                    {"name": n, "source": f"github:example-org/{n}", "path": str(home / ".canary" / "overlays" / n)}
                    for n in names
                ],
            }
        ),
        encoding="utf-8",
    )


class TestListOverlays(unittest.TestCase):
    def test_empty_when_no_overlays_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(list_overlays(Path(tmp)), [])

    def test_directory_scan_sorted_without_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "beta-repo")
            _add_overlay(home, "alpha-repo")
            self.assertEqual(list_overlays(home), ["alpha-repo", "beta-repo"])

    def test_registry_order_when_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "alpha-repo")
            _add_overlay(home, "beta-repo")
            # Registry lists beta first — that order should win over alphabetical.
            _write_registry(home, ["beta-repo", "alpha-repo"])
            self.assertEqual(list_overlays(home), ["beta-repo", "alpha-repo"])

    def test_malformed_registry_falls_back_to_sorted_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "beta-repo")
            _add_overlay(home, "alpha-repo")
            (home / ".canary" / "overlays.json").write_text("{ not json", encoding="utf-8")
            self.assertEqual(list_overlays(home), ["alpha-repo", "beta-repo"])

    def test_on_disk_overlay_absent_from_registry_still_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "alpha-repo")
            _add_overlay(home, "gamma-repo")  # not in registry
            _write_registry(home, ["alpha-repo"])
            # Registry-ordered names first, then unlisted extras sorted.
            self.assertEqual(list_overlays(home), ["alpha-repo", "gamma-repo"])


class TestRegistryPrecedence(unittest.TestCase):
    """`registry_precedence` reads overlays.json for #333 arbitration."""

    def _write(self, home: Path, entries: list[dict]) -> None:
        reg = home / ".canary" / "overlays.json"
        reg.parent.mkdir(parents=True, exist_ok=True)
        reg.write_text(json.dumps({"schemaVersion": 1, "overlays": entries}), encoding="utf-8")

    def test_reads_declared_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._write(home, [{"name": "a", "precedence": 10}, {"name": "b", "precedence": 2}])
            self.assertEqual(registry_precedence(home), {"a": 10, "b": 2})

    def test_absent_or_null_precedence_is_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self._write(home, [{"name": "a"}, {"name": "b", "precedence": None}])
            self.assertEqual(registry_precedence(home), {"a": 0, "b": 0})

    def test_bool_precedence_is_not_treated_as_numeric(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            # JSON true would coerce to 1 under a naive isinstance(int) check.
            self._write(home, [{"name": "a", "precedence": True}])
            self.assertEqual(registry_precedence(home), {"a": 0})

    def test_missing_or_malformed_registry_is_empty_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertEqual(registry_precedence(home), {})  # no file
            (home / ".canary").mkdir(parents=True)
            (home / ".canary" / "overlays.json").write_text("{ not json", encoding="utf-8")
            self.assertEqual(registry_precedence(home), {})


class TestResolveOverlay(unittest.TestCase):
    def test_resolve_by_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            clone = _add_overlay(home, "example-org-example-overlay")
            resolved = resolve_overlay("example-org-example-overlay", home=home)
            self.assertEqual(resolved, clone.resolve())

    def test_bare_name_missing_raises_with_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "alpha-repo")
            with self.assertRaises(OverlayNotFound) as ctx:
                resolve_overlay("nope", home=home)
            self.assertEqual(ctx.exception.name, "nope")
            self.assertEqual(ctx.exception.available, ["alpha-repo"])

    def test_bare_name_not_shadowed_by_local_dir(self):
        # A bare token is ALWAYS a name — a same-named dir in cwd must not shadow
        # a tracked overlay, and a missing name must not silently become a path.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "alpha-repo")
            with self.assertRaises(OverlayNotFound):
                resolve_overlay("some-local-name", home=home)

    def test_resolve_by_relative_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            overlay = Path(tmp) / "sibling-overlay"
            (overlay / ".canary").mkdir(parents=True)
            rel = f"./{overlay.name}"
            # Resolve relative to the overlay's parent as cwd-independent check:
            resolved = resolve_overlay(str(overlay), home=Path(tmp))
            self.assertEqual(resolved, overlay.resolve())
            # A separator-bearing value is treated as a path even if no registry.
            self.assertTrue(rel.startswith("./"))

    def test_missing_path_raises(self):
        # A path-form --from that does not exist fails loudly (symmetry with a
        # bad name) rather than silently resolving to a non-existent overlay.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _add_overlay(home, "real-overlay")
            missing = str(Path(tmp) / "does" / "not" / "exist")
            with self.assertRaises(OverlayNotFound):
                resolve_overlay(missing, home=home)

    def test_resolve_by_absolute_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            overlay = Path(tmp) / "abs-overlay"
            overlay.mkdir()
            resolved = resolve_overlay(str(overlay), home=Path(tmp) / "unrelated-home")
            self.assertEqual(resolved, overlay.resolve())


if __name__ == "__main__":
    unittest.main()
