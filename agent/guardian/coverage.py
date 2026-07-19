"""Tiered, agent-free coverage-fidelity resolution for the PR guardian.

Phase 1 (Tier 0) — resolves diff-coverage for a changed unit at the highest
available fidelity: an explicit coverage **report** beats a **graph**-derived
signal beats a naming **heuristic**. Each result is labeled with its
:class:`Fidelity` so downstream findings can communicate confidence.

SC-11 boundary: this module imports **no** agent/LLM module and never references
the ``analyze_diff``/``get_impact`` MCP tools. Graph coverage reads the NDJSON
``.harness/graph/graph.json`` directly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class Fidelity(str, Enum):
    """Confidence tier of a coverage signal (lower ``rank`` == higher fidelity)."""

    COVERAGE_VERIFIED = "coverage-verified"
    GRAPH_VERIFIED = "graph-verified"
    HEURISTIC = "heuristic"

    @property
    def rank(self) -> int:
        """0=coverage, 1=graph, 2=heuristic. Lower means higher fidelity."""
        return {
            "coverage-verified": 0,
            "graph-verified": 1,
            "heuristic": 2,
        }[self.value]


@dataclass
class ChangedUnit:
    """A file changed by a diff, with the line ranges it *added*.

    ``added_ranges`` are inclusive, 1-based ``(start, end)`` line ranges.
    """

    path: str
    added_ranges: list[tuple[int, int]]
    symbol: str | None = None


@dataclass
class CoverageResult:
    """The resolved coverage verdict for a single :class:`ChangedUnit`."""

    unit: ChangedUnit
    covered: bool
    fidelity: Fidelity
    evidence: str
    uncovered_lines: list[int] = field(default_factory=list)


def _expand_ranges(ranges: list[tuple[int, int]]) -> list[int]:
    """Flatten inclusive ``(start, end)`` ranges into a sorted list of line numbers."""
    lines: list[int] = []
    for start, end in ranges:
        lines.extend(range(start, end + 1))
    return sorted(set(lines))


def _match_hits(path: str, index: dict[str, dict[int, int]]) -> dict[int, int] | None:
    """Look up per-line hit counts for ``path`` in a report index.

    Tries exact match first, then a suffix match either direction (report paths
    may be absolute, ``./``-prefixed, or repo-relative).
    """
    if path in index:
        return index[path]
    for report_path, hits in index.items():
        if report_path.endswith(path) or path.endswith(report_path):
            return hits
    return None


def _parse_lcov(text: str) -> dict[str, dict[int, int]]:
    """Parse ``lcov.info`` into ``{path: {line: hits}}``."""
    index: dict[str, dict[int, int]] = {}
    current: str | None = None
    for line in text.splitlines():
        if line.startswith("SF:"):
            current = line[3:].strip()
            index.setdefault(current, {})
        elif line.startswith("DA:") and current is not None:
            body = line[3:].strip()
            parts = body.split(",")
            if len(parts) >= 2:
                try:
                    lineno, hits = int(parts[0]), int(parts[1])
                except ValueError:
                    continue
                index[current][lineno] = hits
        elif line.strip() == "end_of_record":
            current = None
    return index


def _parse_coverage_json(data: object) -> dict[str, dict[int, int]] | None:
    """Parse the canary/plan coverage-json shape into ``{path: {line: hits}}``.

    Supports ``{"files": {"<path>": {"covered_lines": [...]}}}`` and the same
    with an explicit ``line_hits`` mapping. Unrecognized structure → ``None``.
    """
    if not isinstance(data, dict):
        return None
    files = data.get("files")
    if not isinstance(files, dict):
        return None
    index: dict[str, dict[int, int]] = {}
    for path, entry in files.items():
        if not isinstance(entry, dict):
            continue
        hits: dict[int, int] = {}
        line_hits = entry.get("line_hits")
        if isinstance(line_hits, dict):
            for k, v in line_hits.items():
                try:
                    hits[int(k)] = int(v)
                except (ValueError, TypeError):
                    continue
        covered = entry.get("covered_lines")
        if isinstance(covered, list):
            for lineno in covered:
                if isinstance(lineno, int):
                    hits[lineno] = max(hits.get(lineno, 0), 1)
        index[str(path)] = hits
    return index


def resolve_from_report(
    units: list[ChangedUnit], report_path: Path
) -> list[CoverageResult] | None:
    """Tier 1: resolve coverage from an explicit report (``COVERAGE_VERIFIED``).

    Supports ``lcov.info`` (``DA:<line>,<hits>``) and the canary coverage-json
    shape. Unrecognized/empty/unreadable → ``None`` (caller falls through to a
    lower fidelity tier — absence never blocks).
    """
    try:
        if not report_path.exists():
            return None
        text = report_path.read_text(encoding="utf-8")
    except OSError:
        return None

    name = report_path.name.lower()
    index: dict[str, dict[int, int]] | None
    if name.endswith(".json"):
        try:
            index = _parse_coverage_json(json.loads(text))
        except json.JSONDecodeError:
            return None
    elif name.endswith(".info") or "lcov" in name:
        index = _parse_lcov(text)
    else:
        # Unrecognized format (e.g. Cobertura coverage.xml) → fall through.
        return None

    if not index:
        return None

    results: list[CoverageResult] = []
    for unit in units:
        hits = _match_hits(unit.path, index) or {}
        added = _expand_ranges(unit.added_ranges)
        uncovered = [ln for ln in added if hits.get(ln, 0) <= 0]
        covered = not uncovered
        if covered:
            evidence = f"lines {_ranges_str(unit.added_ranges)}: all covered"
        else:
            evidence = f"lines {_ranges_str(unit.added_ranges)}: {len(uncovered)} uncovered"
        results.append(
            CoverageResult(
                unit=unit,
                covered=covered,
                fidelity=Fidelity.COVERAGE_VERIFIED,
                evidence=evidence,
                uncovered_lines=uncovered,
            )
        )
    return results


def _ranges_str(ranges: list[tuple[int, int]]) -> str:
    """Render ranges compactly, e.g. ``[(12, 28), (30, 30)]`` → ``"12-28, 30"``."""
    parts = []
    for start, end in ranges:
        parts.append(str(start) if start == end else f"{start}-{end}")
    return ", ".join(parts)
