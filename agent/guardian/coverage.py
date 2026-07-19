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

from dataclasses import dataclass, field
from enum import Enum


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
