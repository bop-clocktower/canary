"""TDD for agent.guardian.coverage — tiered coverage fidelity resolver.

Phase 1 (deterministic, agent-free). SC-3: highest-available-fidelity
resolution per changed unit (report > graph > heuristic), each labeled.
"""

from __future__ import annotations

from pathlib import Path

from agent.guardian.coverage import (
    ChangedUnit,
    CoverageResult,
    Fidelity,
    resolve_coverage,
    resolve_from_graph,
    resolve_from_report,
    resolve_heuristic,
)


class TestShapes:
    def test_fidelity_rank_order(self) -> None:
        # Lower rank == higher fidelity.
        assert Fidelity.COVERAGE_VERIFIED.rank < Fidelity.GRAPH_VERIFIED.rank
        assert Fidelity.GRAPH_VERIFIED.rank < Fidelity.HEURISTIC.rank

    def test_fidelity_str_values(self) -> None:
        assert Fidelity.COVERAGE_VERIFIED.value == "coverage-verified"
        assert Fidelity.GRAPH_VERIFIED.value == "graph-verified"
        assert Fidelity.HEURISTIC.value == "heuristic"

    def test_changed_unit_fields(self) -> None:
        unit = ChangedUnit(path="agent/core/foo.py", added_ranges=[(12, 28)])
        assert unit.path == "agent/core/foo.py"
        assert unit.added_ranges == [(12, 28)]
        assert unit.symbol is None

    def test_coverage_result_fields(self) -> None:
        unit = ChangedUnit(path="agent/core/foo.py", added_ranges=[(1, 3)])
        result = CoverageResult(
            unit=unit,
            covered=False,
            fidelity=Fidelity.HEURISTIC,
            evidence="no test references foo",
            uncovered_lines=[1, 2, 3],
        )
        assert result.unit is unit
        assert result.covered is False
        assert result.fidelity is Fidelity.HEURISTIC
        assert result.evidence == "no test references foo"
        assert result.uncovered_lines == [1, 2, 3]

    def test_coverage_result_uncovered_defaults_empty(self) -> None:
        unit = ChangedUnit(path="x.py", added_ranges=[(1, 1)])
        result = CoverageResult(
            unit=unit,
            covered=True,
            fidelity=Fidelity.COVERAGE_VERIFIED,
            evidence="all hit",
        )
        assert result.uncovered_lines == []


LCOV_FIXTURE = """\
SF:pkg/foo.py
DA:12,3
DA:13,1
DA:14,0
DA:15,2
end_of_record
SF:pkg/bar.py
DA:1,5
DA:2,4
end_of_record
"""

JSON_FIXTURE = {
    "files": {
        "pkg/foo.py": {"covered_lines": [12, 13, 15]},
        "pkg/bar.py": {"covered_lines": [1, 2]},
    }
}


class TestResolveFromReport:
    def _units(self):
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(12, 15)])
        bar = ChangedUnit(path="pkg/bar.py", added_ranges=[(1, 2)])
        return foo, bar

    def test_lcov_covered_and_uncovered(self, tmp_path: Path) -> None:
        report = tmp_path / "lcov.info"
        report.write_text(LCOV_FIXTURE, encoding="utf-8")
        foo, bar = self._units()

        results = resolve_from_report([foo, bar], report)
        assert results is not None
        by_path = {r.unit.path: r for r in results}

        # foo added line 14 has 0 hits → uncovered.
        assert by_path["pkg/foo.py"].covered is False
        assert by_path["pkg/foo.py"].uncovered_lines == [14]
        assert by_path["pkg/foo.py"].fidelity is Fidelity.COVERAGE_VERIFIED

        # bar all added lines hit → covered.
        assert by_path["pkg/bar.py"].covered is True
        assert by_path["pkg/bar.py"].uncovered_lines == []
        assert by_path["pkg/bar.py"].fidelity is Fidelity.COVERAGE_VERIFIED

    def test_json_covered_and_uncovered(self, tmp_path: Path) -> None:
        import json

        report = tmp_path / "coverage.json"
        report.write_text(json.dumps(JSON_FIXTURE), encoding="utf-8")
        foo, bar = self._units()

        results = resolve_from_report([foo, bar], report)
        assert results is not None
        by_path = {r.unit.path: r for r in results}

        # foo line 14 absent from covered_lines → uncovered.
        assert by_path["pkg/foo.py"].covered is False
        assert by_path["pkg/foo.py"].uncovered_lines == [14]
        assert by_path["pkg/bar.py"].covered is True

    def test_unrecognized_format_returns_none(self, tmp_path: Path) -> None:
        report = tmp_path / "coverage.xml"
        report.write_text("<coverage/>", encoding="utf-8")
        foo, _ = self._units()
        assert resolve_from_report([foo], report) is None

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        foo, _ = self._units()
        assert resolve_from_report([foo], tmp_path / "nope.json") is None

    def test_exact_report_path_preferred_over_suffix(self, tmp_path: Path) -> None:
        # FIX 6 (guard): duplicate basenames must resolve against the EXACT path,
        # not a same-basename sibling.
        import json

        report = tmp_path / "coverage.json"
        report.write_text(
            json.dumps({"files": {
                "models/foo.py": {"covered_lines": [1]},   # hit
                "utils/foo.py": {"covered_lines": []},      # line 1 unhit
            }}),
            encoding="utf-8",
        )
        unit = ChangedUnit(path="utils/foo.py", added_ranges=[(1, 1)])
        results = resolve_from_report([unit], report)
        assert results is not None
        by = {r.unit.path: r for r in results}
        assert by["utils/foo.py"].covered is False  # not models/foo.py's hit

    def test_report_suffix_requires_separator_boundary(
        self, tmp_path: Path
    ) -> None:
        # FIX 6: a report entry 'lib/foobar.py' must NOT loosely suffix-match a
        # distinct unit 'bar.py' (no path-separator boundary) → no false cover.
        import json

        report = tmp_path / "coverage.json"
        report.write_text(
            json.dumps({"files": {"lib/foobar.py": {"covered_lines": [1]}}}),
            encoding="utf-8",
        )
        unit = ChangedUnit(path="bar.py", added_ranges=[(1, 1)])
        results = resolve_from_report([unit], report)
        # No boundary match → no report signal for bar.py → it is skipped so the
        # orchestrator falls through (not falsely COVERAGE_VERIFIED-covered).
        assert results == []

    def test_report_ambiguous_basename_skips(self, tmp_path: Path) -> None:
        # FIX 6: a bare-basename unit that suffix-matches multiple report entries
        # is ambiguous → no report signal (skip), not first-match-wins.
        import json

        report = tmp_path / "coverage.json"
        report.write_text(
            json.dumps({"files": {
                "a/foo.py": {"covered_lines": [1]},
                "b/foo.py": {"covered_lines": [1]},
            }}),
            encoding="utf-8",
        )
        unit = ChangedUnit(path="foo.py", added_ranges=[(1, 1)])
        results = resolve_from_report([unit], report)
        assert results == []


def _ndjson(*records) -> str:
    import json

    return "\n".join(json.dumps(r) for r in records) + "\n"


GRAPH_FIXTURE = _ndjson(
    {"kind": "node", "type": "file", "id": "file:pkg/foo.py", "path": "pkg/foo.py"},
    {"kind": "node", "type": "function", "id": "function:pkg/foo.py:do_it",
     "path": "pkg/foo.py"},
    {"kind": "node", "type": "file", "id": "file:pkg/bar.py", "path": "pkg/bar.py"},
    {"kind": "node", "type": "file", "id": "file:tests/test_foo.py",
     "path": "tests/test_foo.py"},
    # source file contains its symbol
    {"kind": "edge", "from": "file:pkg/foo.py", "to": "function:pkg/foo.py:do_it",
     "type": "contains"},
    # test calls the source symbol → foo is graph-covered (derived)
    {"kind": "edge", "from": "file:tests/test_foo.py",
     "to": "function:pkg/foo.py:do_it", "type": "calls"},
    # bar has no inbound test edge → uncovered
)


class TestResolveFromGraph:
    def test_covered_via_test_calls_edge(self, tmp_path: Path) -> None:
        graph = tmp_path / "graph.json"
        graph.write_text(GRAPH_FIXTURE, encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 5)])
        bar = ChangedUnit(path="pkg/bar.py", added_ranges=[(1, 5)])

        results = resolve_from_graph([foo, bar], graph)
        assert results is not None
        by_path = {r.unit.path: r for r in results}

        assert by_path["pkg/foo.py"].covered is True
        assert by_path["pkg/foo.py"].fidelity is Fidelity.GRAPH_VERIFIED
        assert "tests/test_foo.py" in by_path["pkg/foo.py"].evidence

        assert by_path["pkg/bar.py"].covered is False
        assert by_path["pkg/bar.py"].fidelity is Fidelity.GRAPH_VERIFIED

    def test_direct_file_import_edge_covers(self, tmp_path: Path) -> None:
        graph = tmp_path / "graph.json"
        graph.write_text(
            _ndjson(
                {"kind": "node", "type": "file", "id": "file:pkg/baz.py",
                 "path": "pkg/baz.py"},
                {"kind": "node", "type": "file", "id": "file:tests/test_baz.py",
                 "path": "tests/test_baz.py"},
                {"kind": "edge", "from": "file:tests/test_baz.py",
                 "to": "file:pkg/baz.py", "type": "imports"},
            ),
            encoding="utf-8",
        )
        baz = ChangedUnit(path="pkg/baz.py", added_ranges=[(1, 3)])
        results = resolve_from_graph([baz], graph)
        assert results is not None
        assert results[0].covered is True

    def test_missing_graph_returns_none(self, tmp_path: Path) -> None:
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 5)])
        assert resolve_from_graph([foo], tmp_path / "absent.json") is None

    def test_empty_graph_returns_none(self, tmp_path: Path) -> None:
        graph = tmp_path / "graph.json"
        graph.write_text("", encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 5)])
        assert resolve_from_graph([foo], graph) is None

    def test_non_dict_ndjson_lines_ignored(self, tmp_path: Path) -> None:
        # FIX 3: valid-JSON but non-object lines (null, a number, an array) must
        # be skipped, not crash the resolver with AttributeError on `.get`.
        graph = tmp_path / "graph.json"
        lines = [
            '{"kind": "node", "type": "file", "id": "file:pkg/foo.py", '
            '"path": "pkg/foo.py"}',
            "5",
            "[1, 2]",
            "null",
            '"a bare string"',
            '{"kind": "node", "type": "file", "id": "file:tests/test_foo.py", '
            '"path": "tests/test_foo.py"}',
            '{"kind": "edge", "from": "file:tests/test_foo.py", '
            '"to": "file:pkg/foo.py", "type": "imports"}',
        ]
        graph.write_text("\n".join(lines) + "\n", encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 3)])

        results = resolve_from_graph([foo], graph)
        assert results is not None
        # Valid records still resolve → foo is covered by the test import edge.
        assert results[0].covered is True

    def test_graph_suffix_requires_separator_boundary(
        self, tmp_path: Path
    ) -> None:
        # FIX 6: a node 'x/foobar.py' reached by a test must NOT loosely
        # suffix-match a distinct changed unit 'bar.py' (no separator boundary).
        graph = tmp_path / "graph.json"
        graph.write_text(
            _ndjson(
                {"kind": "node", "type": "file", "id": "file:x/foobar.py",
                 "path": "x/foobar.py"},
                {"kind": "node", "type": "file", "id": "file:tests/test_x.py",
                 "path": "tests/test_x.py"},
                {"kind": "edge", "from": "file:tests/test_x.py",
                 "to": "file:x/foobar.py", "type": "imports"},
            ),
            encoding="utf-8",
        )
        unit = ChangedUnit(path="bar.py", added_ranges=[(1, 3)])
        results = resolve_from_graph([unit], graph)
        # No boundary match → no graph node for bar.py → no graph signal (skip).
        assert results == []

    def test_graph_ambiguous_basename_not_unioned(
        self, tmp_path: Path
    ) -> None:
        # FIX 6: a test reaching an unrelated 'a/foo.py' must NOT mark a distinct
        # 'b/foo.py' covered by unioning same-basename nodes for a bare unit.
        graph = tmp_path / "graph.json"
        graph.write_text(
            _ndjson(
                {"kind": "node", "type": "file", "id": "file:a/foo.py",
                 "path": "a/foo.py"},
                {"kind": "node", "type": "file", "id": "file:b/foo.py",
                 "path": "b/foo.py"},
                {"kind": "node", "type": "file", "id": "file:tests/test_a.py",
                 "path": "tests/test_a.py"},
                {"kind": "edge", "from": "file:tests/test_a.py",
                 "to": "file:a/foo.py", "type": "imports"},
            ),
            encoding="utf-8",
        )
        unit = ChangedUnit(path="foo.py", added_ranges=[(1, 3)])
        results = resolve_from_graph([unit], graph)
        # Ambiguous suffix (a/foo.py and b/foo.py) → no confident node → skip,
        # rather than unioning both and falsely covering via a/foo.py's test.
        assert results == []


# A DIRECT test→source edge: test_foo.py imports foo.py straight (one hop).
_DIRECT_EDGE_GRAPH = _ndjson(
    {"kind": "node", "type": "file", "id": "file:pkg/foo.py", "path": "pkg/foo.py"},
    {"kind": "node", "type": "file", "id": "file:tests/test_foo.py",
     "path": "tests/test_foo.py"},
    {"kind": "edge", "from": "file:tests/test_foo.py",
     "to": "file:pkg/foo.py", "type": "imports"},
)

# A PURELY-TRANSITIVE reach: test_a.py imports b.py, b.py imports foo.py. There
# is NO direct test→foo edge — only an indirect two-hop path. Unbounded BFS
# over-credits foo as covered; a depth-1 gate must treat it as uncovered.
_TRANSITIVE_GRAPH = _ndjson(
    {"kind": "node", "type": "file", "id": "file:pkg/foo.py", "path": "pkg/foo.py"},
    {"kind": "node", "type": "file", "id": "file:pkg/b.py", "path": "pkg/b.py"},
    {"kind": "node", "type": "file", "id": "file:tests/test_a.py",
     "path": "tests/test_a.py"},
    {"kind": "edge", "from": "file:tests/test_a.py",
     "to": "file:pkg/b.py", "type": "imports"},
    {"kind": "edge", "from": "file:pkg/b.py",
     "to": "file:pkg/foo.py", "type": "imports"},
)


class TestResolveFromGraphDepth:
    """#320: a bounded reverse-BFS can require a direct (or shallow) test→source
    edge. ``max_depth=1`` = direct edge only; ``max_depth=2`` = one hop of
    indirection; ``max_depth=None`` = unbounded (today's behavior, unchanged)."""

    def test_direct_edge_covered_at_depth_1(self, tmp_path: Path) -> None:
        # A direct test→source import edge is reached within 1 hop → covered.
        graph = tmp_path / "graph.json"
        graph.write_text(_DIRECT_EDGE_GRAPH, encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 3)])
        results = resolve_from_graph([foo], graph, max_depth=1)
        assert results is not None
        assert results[0].covered is True
        assert results[0].fidelity is Fidelity.GRAPH_VERIFIED

    def test_purely_transitive_uncovered_at_depth_1(self, tmp_path: Path) -> None:
        # THE FIX: a purely-transitive test path (test→b→foo, no direct test→foo
        # edge) must NOT count as covering foo under a depth-1 gate.
        graph = tmp_path / "graph.json"
        graph.write_text(_TRANSITIVE_GRAPH, encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 3)])

        bounded = resolve_from_graph([foo], graph, max_depth=1)
        assert bounded is not None
        assert bounded[0].covered is False  # direct-edge gate: uncovered

        # PROOF the old (unbounded) behavior over-credited: the SAME fixture with
        # max_depth=None reaches test_a two hops out and marks foo covered.
        unbounded = resolve_from_graph([foo], graph, max_depth=None)
        assert unbounded is not None
        assert unbounded[0].covered is True

    def test_depth_boundary_two_hops(self, tmp_path: Path) -> None:
        # The transitive fixture is covered at depth 2 (one hop of indirection is
        # allowed) but uncovered at depth 1 (direct edge only).
        graph = tmp_path / "graph.json"
        graph.write_text(_TRANSITIVE_GRAPH, encoding="utf-8")
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 3)])

        covered_at_2 = resolve_from_graph([foo], graph, max_depth=2)
        assert covered_at_2 is not None
        assert covered_at_2[0].covered is True

        uncovered_at_1 = resolve_from_graph([foo], graph, max_depth=1)
        assert uncovered_at_1 is not None
        assert uncovered_at_1[0].covered is False


class TestResolveHeuristic:
    def _repo(self, tmp_path: Path):
        (tmp_path / "pkg").mkdir()
        (tmp_path / "tests").mkdir()
        (tmp_path / "pkg" / "foo.py").write_text(
            "def do_it():\n    return 1\n", encoding="utf-8"
        )
        (tmp_path / "pkg" / "bar.py").write_text(
            "def other():\n    return 2\n", encoding="utf-8"
        )
        (tmp_path / "tests" / "test_foo.py").write_text(
            "from pkg import foo\n\ndef test_do_it():\n    assert foo.do_it() == 1\n",
            encoding="utf-8",
        )
        return tmp_path

    def test_stem_referenced_by_test_is_covered(self, tmp_path: Path) -> None:
        repo = self._repo(tmp_path)
        foo = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)])
        results = resolve_heuristic([foo], repo_root=repo)
        assert results[0].covered is True
        assert results[0].fidelity is Fidelity.HEURISTIC
        assert "test_foo.py" in results[0].evidence

    def test_unreferenced_unit_is_uncovered(self, tmp_path: Path) -> None:
        repo = self._repo(tmp_path)
        bar = ChangedUnit(path="pkg/bar.py", added_ranges=[(1, 2)])
        results = resolve_heuristic([bar], repo_root=repo)
        assert results[0].covered is False
        assert results[0].fidelity is Fidelity.HEURISTIC

    def test_symbol_name_reference_covers(self, tmp_path: Path) -> None:
        # A test that mentions the symbol name (not the module stem) still counts.
        repo = tmp_path
        (repo / "pkg").mkdir()
        (repo / "tests").mkdir()
        (repo / "pkg" / "widget.py").write_text(
            "class GadgetMaker:\n    pass\n", encoding="utf-8"
        )
        (repo / "tests" / "test_things.py").write_text(
            "from pkg.widget import GadgetMaker\n\n"
            "def test_it():\n    assert GadgetMaker()\n",
            encoding="utf-8",
        )
        unit = ChangedUnit(path="pkg/widget.py", added_ranges=[(1, 2)])
        results = resolve_heuristic([unit], repo_root=repo)
        assert results[0].covered is True

    def test_always_returns_one_result_per_unit(self, tmp_path: Path) -> None:
        repo = self._repo(tmp_path)
        units = [
            ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)]),
            ChangedUnit(path="pkg/bar.py", added_ranges=[(1, 2)]),
        ]
        results = resolve_heuristic(units, repo_root=repo)
        assert len(results) == 2
        assert all(r.fidelity is Fidelity.HEURISTIC for r in results)


class TestResolveCoverage:
    """SC-3 fidelity ladder: report > graph > heuristic, first available wins."""

    def _build_repo(self, tmp_path: Path):
        # Source + test files (heuristic tier always available here).
        (tmp_path / "pkg").mkdir()
        (tmp_path / "tests").mkdir()
        (tmp_path / "pkg" / "foo.py").write_text(
            "def do_it():\n    return 1\n", encoding="utf-8"
        )
        (tmp_path / "tests" / "test_foo.py").write_text(
            "from pkg import foo\n\ndef test_do_it():\n    assert foo.do_it() == 1\n",
            encoding="utf-8",
        )
        # Graph tier artifact.
        graph = tmp_path / "graph.json"
        graph.write_text(
            _ndjson(
                {"kind": "node", "type": "file", "id": "file:pkg/foo.py",
                 "path": "pkg/foo.py"},
                {"kind": "node", "type": "file", "id": "file:tests/test_foo.py",
                 "path": "tests/test_foo.py"},
                {"kind": "edge", "from": "file:tests/test_foo.py",
                 "to": "file:pkg/foo.py", "type": "imports"},
            ),
            encoding="utf-8",
        )
        # Report tier artifact.
        import json

        report = tmp_path / "coverage.json"
        report.write_text(
            json.dumps({"files": {"pkg/foo.py": {"covered_lines": [1, 2]}}}),
            encoding="utf-8",
        )
        return graph, report

    def test_report_wins_when_all_present(self, tmp_path: Path) -> None:
        graph, report = self._build_repo(tmp_path)
        unit = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)])
        results = resolve_coverage(
            [unit], coverage_path=report, graph_path=graph, repo_root=tmp_path
        )
        assert len(results) == 1
        assert results[0].fidelity is Fidelity.COVERAGE_VERIFIED

    def test_graph_wins_when_no_report(self, tmp_path: Path) -> None:
        graph, _ = self._build_repo(tmp_path)
        unit = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)])
        results = resolve_coverage(
            [unit], coverage_path=None, graph_path=graph, repo_root=tmp_path
        )
        assert len(results) == 1
        assert results[0].fidelity is Fidelity.GRAPH_VERIFIED

    def test_heuristic_when_no_report_no_graph(self, tmp_path: Path) -> None:
        self._build_repo(tmp_path)
        unit = ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)])
        results = resolve_coverage(
            [unit],
            coverage_path=None,
            graph_path=tmp_path / "absent.json",
            repo_root=tmp_path,
        )
        assert len(results) == 1
        assert results[0].fidelity is Fidelity.HEURISTIC

    def test_exactly_one_result_per_unit(self, tmp_path: Path) -> None:
        graph, report = self._build_repo(tmp_path)
        units = [
            ChangedUnit(path="pkg/foo.py", added_ranges=[(1, 2)]),
            ChangedUnit(path="pkg/missing.py", added_ranges=[(1, 2)]),
        ]
        results = resolve_coverage(
            [*units], coverage_path=report, graph_path=graph, repo_root=tmp_path
        )
        assert len(results) == len(units)
        assert [r.unit.path for r in results] == [u.path for u in units]

    def test_unit_absent_from_report_falls_through_per_unit(
        self, tmp_path: Path
    ) -> None:
        # FIX 2: a report that lists pkg/a.py but NOT pkg/NEW.py must not judge
        # NEW.py as COVERAGE_VERIFIED-uncovered (HIGH from absent data). NEW.py
        # has a graph signal (reached by a test) → resolves GRAPH_VERIFIED, and
        # the reported unit stays COVERAGE_VERIFIED.
        import json

        report = tmp_path / "coverage.json"
        report.write_text(
            json.dumps({"files": {"pkg/a.py": {"covered_lines": [1]}}}),
            encoding="utf-8",
        )
        graph = tmp_path / "graph.json"
        graph.write_text(
            _ndjson(
                {"kind": "node", "type": "file", "id": "file:pkg/NEW.py",
                 "path": "pkg/NEW.py"},
                {"kind": "node", "type": "file", "id": "file:tests/test_new.py",
                 "path": "tests/test_new.py"},
                {"kind": "edge", "from": "file:tests/test_new.py",
                 "to": "file:pkg/NEW.py", "type": "imports"},
            ),
            encoding="utf-8",
        )
        reported = ChangedUnit(path="pkg/a.py", added_ranges=[(1, 1)])
        new_unit = ChangedUnit(path="pkg/NEW.py", added_ranges=[(1, 3)])

        results = resolve_coverage(
            [reported, new_unit],
            coverage_path=report,
            graph_path=graph,
            repo_root=tmp_path,
        )
        by_path = {r.unit.path: r for r in results}

        assert by_path["pkg/a.py"].fidelity is Fidelity.COVERAGE_VERIFIED
        # NEW.py is absent from the report → NOT COVERAGE_VERIFIED, not HIGH from
        # fabricated "uncovered" data; it falls through to the graph tier.
        assert by_path["pkg/NEW.py"].fidelity is Fidelity.GRAPH_VERIFIED
        assert by_path["pkg/NEW.py"].covered is True
