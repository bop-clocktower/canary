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

import ast
import json
import re
from collections import deque
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


def _path_boundary_match(candidate: str, target: str) -> bool:
    """True iff ``candidate`` and ``target`` name the same file path suffix.

    Exact match, or one is a suffix of the other on a **path-separator boundary**
    (``a/b/foo.py`` vs ``foo.py``). Rejects loose substring collisions such as
    ``foobar.py`` vs ``bar.py`` and ``usermodels.py`` vs ``models.py`` (FIX 6).
    """
    return (
        candidate == target
        or candidate.endswith("/" + target)
        or target.endswith("/" + candidate)
    )


def _match_hits(path: str, index: dict[str, dict[int, int]]) -> dict[int, int] | None:
    """Look up per-line hit counts for ``path`` in a report index.

    Prefers an EXACT path match. Otherwise falls back to a **boundary** suffix
    match (report paths may be absolute, ``./``-prefixed, or repo-relative). On
    multiple boundary matches (duplicate basenames) the lookup is ambiguous and
    returns ``None`` — the unit is then skipped and falls through rather than
    binding to an arbitrary first match (FIX 6).
    """
    if path in index:
        return index[path]
    matches = [
        hits for report_path, hits in index.items()
        if _path_boundary_match(report_path, path)
    ]
    if len(matches) == 1:
        return matches[0]
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
        hits = _match_hits(unit.path, index)
        if hits is None:
            # Unit path is nowhere in the report index → "not instrumented",
            # which is NOT the same as "instrumented and unhit". Emit no
            # COVERAGE_VERIFIED result so the orchestrator falls through to a
            # lower-fidelity tier for this unit (FIX 2).
            continue
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


# Edge types that indicate a test exercises a source unit (see graph-derivation
# assumption in the Phase 1 plan). The live graph carries no explicit
# `tests`/`covers` edge, so coverage is *derived* from calls/imports reach.
_REACH_EDGE_TYPES = frozenset({"calls", "imports"})

_TEST_PATH_RE = re.compile(
    r"(^|/)tests?/|(^|/)test_[^/]*\.py$|\.test\.[^/]+$|\.spec\.[^/]+$"
)


def is_test_path(path: str) -> bool:
    """True if ``path`` looks like a test file (``tests/**``, ``test_*.py``,
    ``*.test.*``, ``*.spec.*``)."""
    return bool(_TEST_PATH_RE.search(path))


def resolve_from_graph(
    units: list[ChangedUnit],
    graph_path: Path = Path(".harness/graph/graph.json"),
    max_depth: int | None = None,
) -> list[CoverageResult] | None:
    """Tier 2: derive coverage from the harness knowledge graph (``GRAPH_VERIFIED``).

    The graph has no explicit ``tests``/``covers`` edge, so coverage is
    **derived**: a changed file is graph-covered iff some **test-path node**
    reaches the file's node (or a symbol node it ``contains``) via a
    ``calls``/``imports`` edge. Conservative by design (edge present → covered).

    ``max_depth`` bounds the reverse-BFS hop distance from the changed unit's
    node(s) to the covering test node (#320). The changed unit's nodes are
    depth 0; their direct predecessors (a test with a ``calls``/``imports`` edge
    straight into a target node or a ``contains``-symbol of it) are depth 1; one
    hop of indirection is depth 2; and so on. A test-path node reached within
    ``max_depth`` hops counts as covering. ``max_depth=1`` therefore requires a
    DIRECT test→source edge; ``max_depth=None`` is unbounded (today's behavior,
    byte-for-byte unchanged).

    Reads the NDJSON ``graph.json`` directly. Does **not** shell
    ``impact-preview`` (staged-only) or import the ``analyze_diff``/``get_impact``
    MCP tools (SC-11). Missing/empty graph → ``None`` (never blocks).
    """
    try:
        if not graph_path.exists():
            return None
        text = graph_path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not text.strip():
        return None

    id_to_path: dict[str, str] = {}
    contains_fwd: dict[str, list[str]] = {}
    reach_rev: dict[str, list[str]] = {}  # to -> [from] over calls/imports

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            # Valid JSON but not an object (e.g. `null`, `5`, `[1,2]`, `"x"`) →
            # not a node/edge record; skip it rather than crash on `.get` (FIX 3).
            continue
        kind = record.get("kind")
        if kind == "node":
            node_id = record.get("id")
            if node_id is not None:
                id_to_path[node_id] = record.get("path", "")
        elif kind == "edge":
            etype = record.get("type")
            src, dst = record.get("from"), record.get("to")
            if src is None or dst is None:
                continue
            if etype == "contains":
                contains_fwd.setdefault(src, []).append(dst)
            elif etype in _REACH_EDGE_TYPES:
                reach_rev.setdefault(dst, []).append(src)

    if not id_to_path:
        return None

    # Index file/symbol node ids by path (exact + suffix match support).
    path_to_ids: dict[str, list[str]] = {}
    for node_id, node_path in id_to_path.items():
        if node_path:
            path_to_ids.setdefault(node_path, []).append(node_id)

    def _ids_for_path(path: str) -> list[str]:
        if path in path_to_ids:
            return path_to_ids[path]
        # Boundary suffix match only; on a unique matched path use its ids. On
        # multiple distinct matched paths (duplicate basenames) treat as
        # ambiguous and return no ids — do NOT union unrelated nodes (FIX 6).
        matched_paths = [
            node_path for node_path in path_to_ids
            if _path_boundary_match(node_path, path)
        ]
        if len(matched_paths) == 1:
            return path_to_ids[matched_paths[0]]
        return []

    results: list[CoverageResult] = []
    for unit in units:
        # Target set: the file node(s) for this unit + all symbols they contain.
        seed_ids = _ids_for_path(unit.path)
        if not seed_ids:
            # Unit has no node in the graph → no graph signal. Emit nothing so
            # the orchestrator falls through to the heuristic tier (FIX 2).
            continue
        targets: set[str] = set(seed_ids)
        frontier = list(targets)
        while frontier:
            node = frontier.pop()
            for child in contains_fwd.get(node, []):
                if child not in targets:
                    targets.add(child)
                    frontier.append(child)

        # Reverse-BFS over calls/imports; a reached test-path node → covered.
        # ``max_depth`` bounds how far a covering test may sit from a target: a
        # target node is depth 0, its direct predecessors depth 1, etc. A node at
        # ``depth >= max_depth`` cannot be expanded (its predecessors would exceed
        # the bound). ``max_depth=None`` never bounds — unchanged behavior (#320).
        #
        # FIX 1 (#320): a genuine FIFO BFS (``deque.popleft``) — NOT a LIFO stack.
        # All targets are seeded at depth 0 and BFS visits in non-decreasing depth,
        # so first-discovery depth IS the minimum. A LIFO/DFS frontier could stamp
        # an intermediate node at a non-minimal depth via a longer path explored
        # first, then prune it before a shorter path arrives — under-crediting real
        # coverage at ``max_depth >= 3``. FIFO makes ``seen``-at-discovery correct.
        covering_test: str | None = None
        seen = set(targets)
        queue: deque[tuple[str, int]] = deque((t, 0) for t in targets)
        while queue and covering_test is None:
            node, depth = queue.popleft()
            if max_depth is not None and depth >= max_depth:
                continue  # cannot expand deeper — predecessors would exceed bound
            for source in reach_rev.get(node, []):
                if source in seen:
                    continue
                seen.add(source)
                source_path = id_to_path.get(source, "")
                if source_path and is_test_path(source_path) and source not in targets:
                    covering_test = source_path  # test reached within max_depth
                    break
                queue.append((source, depth + 1))

        covered = covering_test is not None
        evidence = (
            f"reached by test {covering_test}"
            if covered
            else f"no test node reaches {unit.path} via calls/imports"
        )
        results.append(
            CoverageResult(
                unit=unit,
                covered=covered,
                fidelity=Fidelity.GRAPH_VERIFIED,
                evidence=evidence,
            )
        )
    return results


def _extract_symbols(unit_path: str, repo_root: Path) -> set[str]:
    """Derive candidate symbol names for a unit: the file stem plus top-level
    ``def``/``class`` names (``ast`` for ``.py``, a cheap regex otherwise)."""
    stem = Path(unit_path).stem
    symbols: set[str] = {stem}
    full = repo_root / unit_path
    try:
        source = full.read_text(encoding="utf-8")
    except OSError:
        return symbols
    if unit_path.endswith(".py"):
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return symbols
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                symbols.add(node.name)
    else:
        for match in re.finditer(
            r"\b(?:function|class|def|const|let|var)\s+([A-Za-z_]\w*)", source
        ):
            symbols.add(match.group(1))
    return symbols


def _iter_test_files(repo_root: Path):
    """Yield ``(path, text)`` for every test-looking file under ``repo_root``."""
    seen: set[Path] = set()
    for pattern in ("test_*.py", "*.test.*", "*.spec.*"):
        for path in repo_root.rglob(pattern):
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            try:
                yield path, path.read_text(encoding="utf-8")
            except OSError:
                continue
    # Also any file living under a tests/ directory (broader net).
    for path in repo_root.rglob("*.py"):
        if path in seen or not path.is_file():
            continue
        rel = path.relative_to(repo_root).as_posix()
        if is_test_path(rel):
            seen.add(path)
            try:
                yield path, path.read_text(encoding="utf-8")
            except OSError:
                continue


def resolve_heuristic(
    units: list[ChangedUnit], repo_root: Path = Path(".")
) -> list[CoverageResult]:
    """Tier 3: last-resort naming/AST heuristic (``HEURISTIC``, never ``None``).

    A unit is heuristic-covered iff some test file under ``repo_root`` references
    the unit's file stem or a top-level symbol name (word-boundary scan).
    """
    test_files = list(_iter_test_files(repo_root))
    results: list[CoverageResult] = []
    for unit in units:
        symbols = _extract_symbols(unit.path, repo_root)
        # Avoid pathological single-letter stems matching everything.
        patterns = {
            re.compile(rf"\b{re.escape(sym)}\b") for sym in symbols if len(sym) >= 2
        }
        covering: str | None = None
        for test_path, text in test_files:
            rel = test_path.relative_to(repo_root).as_posix()
            # A file never counts as covering itself.
            if rel == unit.path:
                continue
            if any(pat.search(text) for pat in patterns):
                covering = rel
                break
        covered = covering is not None
        evidence = (
            f"referenced by {covering}"
            if covered
            else f"no test file references {Path(unit.path).stem}"
        )
        results.append(
            CoverageResult(
                unit=unit,
                covered=covered,
                fidelity=Fidelity.HEURISTIC,
                evidence=evidence,
            )
        )
    return results


def resolve_coverage(
    units: list[ChangedUnit],
    coverage_path: Path | None = None,
    graph_path: Path = Path(".harness/graph/graph.json"),
    repo_root: Path = Path("."),
    graph_max_depth: int | None = None,
) -> list[CoverageResult]:
    """SC-3 orchestrator: resolve each unit at the highest available fidelity.

    The ladder is applied **per unit** (SC-3: "highest available fidelity per
    unit"), not per batch. For each unit the first tier that has a signal for
    *that* unit wins:

    1. ``coverage_path`` lists the unit's path → ``COVERAGE_VERIFIED``
    2. else a graph node for the unit exists   → ``GRAPH_VERIFIED``
    3. else the naming heuristic               → ``HEURISTIC`` (always returns)

    A unit absent from the report is NOT judged COVERAGE_VERIFIED-uncovered; it
    falls through to the graph then heuristic tier (FIX 2). Returns exactly one
    :class:`CoverageResult` per input unit, in input order, fidelity-labeled.

    ``graph_max_depth`` bounds the graph tier's reverse-BFS hop distance (#320):
    ``1`` requires a direct test→source edge, ``None`` (default) is unbounded —
    byte-for-byte today's behavior, so existing soft-default results are
    unchanged. Forwarded verbatim to :func:`resolve_from_graph`.
    """
    resolved: dict[int, CoverageResult] = {}
    remaining: list[ChangedUnit] = list(units)

    if coverage_path is not None:
        report = resolve_from_report(remaining, Path(coverage_path))
        if report:
            resolved.update({id(r.unit): r for r in report})
            remaining = [u for u in remaining if id(u) not in resolved]

    if remaining:
        graph = resolve_from_graph(remaining, graph_path, max_depth=graph_max_depth)
        if graph:
            resolved.update({id(r.unit): r for r in graph})
            remaining = [u for u in remaining if id(u) not in resolved]

    if remaining:
        resolved.update({id(r.unit): r for r in resolve_heuristic(remaining, repo_root)})

    return [resolved[id(unit)] for unit in units]
