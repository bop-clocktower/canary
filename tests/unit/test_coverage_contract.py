"""TDD for the coverage-json producer contract validator.

`_parse_coverage_json` is lenient — it silently drops malformed files, lines,
and values, so a producer emitting a slightly-wrong shape gets zero feedback
and its coverage just vanishes into the heuristic tier. `validate_coverage_json`
is the loud counterpart: it reports, at two severities, exactly what the parser
would silently discard.

- **error**   — the parser cannot use this at all (whole doc → None, or a file
  entry is dropped): coverage is lost.
- **warning** — the parser ignores a sub-part (a bad line/value) but still uses
  the rest: coverage is degraded, not lost.

The binding tests keep the validator honest against the parser it describes.
"""

from __future__ import annotations

from agent.guardian.coverage import (
    _parse_coverage_json,
    validate_coverage_json,
)


def _errors(data: object) -> list:
    return [p for p in validate_coverage_json(data) if p.severity == "error"]


def _warnings(data: object) -> list:
    return [p for p in validate_coverage_json(data) if p.severity == "warning"]


class TestValidShapes:
    def test_line_hits_is_clean(self) -> None:
        data = {"files": {"pkg/foo.py": {"line_hits": {"12": 3, "14": 0}}}}
        assert validate_coverage_json(data) == []

    def test_covered_lines_is_clean(self) -> None:
        data = {"files": {"pkg/foo.py": {"covered_lines": [12, 13, 15]}}}
        assert validate_coverage_json(data) == []

    def test_both_fields_is_clean(self) -> None:
        data = {
            "files": {
                "pkg/foo.py": {"line_hits": {"14": 0}, "covered_lines": [12, 13]}
            }
        }
        assert validate_coverage_json(data) == []

    def test_schema_version_1_is_clean(self) -> None:
        data = {"schema_version": 1, "files": {"a.py": {"covered_lines": [1]}}}
        assert validate_coverage_json(data) == []

    def test_schema_version_absent_is_clean(self) -> None:
        # Absent version is assumed 1 — today's producers stay valid.
        data = {"files": {"a.py": {"covered_lines": [1]}}}
        assert _errors(data) == []

    def test_unknown_top_level_key_is_ignored(self) -> None:
        # Additive-safe: extra keys are not an error.
        data = {"files": {"a.py": {"covered_lines": [1]}}, "meta": {"tool": "x"}}
        assert validate_coverage_json(data) == []


class TestErrors:
    def test_top_level_not_object(self) -> None:
        assert len(_errors([1, 2, 3])) == 1

    def test_files_missing(self) -> None:
        assert _errors({"schema_version": 1}) != []

    def test_files_not_object(self) -> None:
        assert _errors({"files": ["a.py"]}) != []

    def test_entry_not_object_is_error(self) -> None:
        # The parser skips a non-dict entry entirely → that file's coverage is
        # lost, so this is an error, not a warning.
        data = {"files": {"pkg/foo.py": [12, 13]}}
        errs = _errors(data)
        assert errs and "pkg/foo.py" in errs[0].location

    def test_unsupported_schema_version(self) -> None:
        data = {"schema_version": 2, "files": {"a.py": {"covered_lines": [1]}}}
        assert _errors(data) != []


class TestWarnings:
    def test_line_hits_non_int_value(self) -> None:
        data = {"files": {"a.py": {"line_hits": {"12": "three"}}}}
        assert _warnings(data) != [] and _errors(data) == []

    def test_covered_lines_non_int_element(self) -> None:
        data = {"files": {"a.py": {"covered_lines": [12, "x", 14]}}}
        assert _warnings(data) != [] and _errors(data) == []

    def test_line_number_below_one(self) -> None:
        data = {"files": {"a.py": {"covered_lines": [0, 1]}}}
        assert _warnings(data) != []

    def test_entry_with_no_coverage_fields(self) -> None:
        # Parser adds the file with an empty hit map → contributes nothing.
        data = {"files": {"a.py": {}}}
        assert _warnings(data) != [] and _errors(data) == []

    def test_line_hits_not_object(self) -> None:
        data = {"files": {"a.py": {"line_hits": [1, 2]}}}
        assert _warnings(data) != []


class TestParserBinding:
    """The validator's verdict must match what the parser actually does."""

    def test_error_docs_are_unusable_by_parser(self) -> None:
        # A structural error → parser yields nothing usable.
        assert _parse_coverage_json([1, 2, 3]) is None
        assert _parse_coverage_json({"files": ["a.py"]}) is None

    def test_warning_only_docs_still_parse(self) -> None:
        # Warnings mean degraded-not-lost: the parser still returns an index.
        data = {"files": {"a.py": {"line_hits": {"12": "bad", "13": 2}}}}
        assert _errors(data) == []
        index = _parse_coverage_json(data)
        assert index is not None
        # The good line survived; the bad one was dropped (the warning).
        assert index["a.py"] == {13: 2}

    def test_non_integer_values_rejected_by_both(self) -> None:
        # bool/float/numeric-string all coerce via int() in Python, but none is
        # a JSON integer per the contract. Validator warns AND parser drops each,
        # so nothing sneaks in (and 3.7 is never silently truncated to 3).
        for bad in (True, 3.0, "3", 3.7):
            data = {"files": {"a.py": {"line_hits": {"12": bad}}}}
            assert _warnings(data) != [], bad
            assert _errors(data) == [], bad
            assert _parse_coverage_json(data) == {"a.py": {}}, bad

    def test_non_integer_covered_line_rejected_by_both(self) -> None:
        for bad in (False, 2.0, "5"):
            data = {"files": {"a.py": {"covered_lines": [bad]}}}
            assert _warnings(data) != [], bad
            assert _parse_coverage_json(data) == {"a.py": {}}, bad

    def test_clean_doc_parses_to_expected_index(self) -> None:
        data = {"files": {"a.py": {"line_hits": {"14": 0}, "covered_lines": [12]}}}
        assert validate_coverage_json(data) == []
        assert _parse_coverage_json(data) == {"a.py": {12: 1, 14: 0}}

    def test_unsupported_schema_version_is_dropped_by_parser(self) -> None:
        # The validator errors on it; the parser must actually refuse it, or the
        # "coverage lost" error would be a lie.
        data = {"schema_version": 2, "files": {"a.py": {"line_hits": {"1": 3}}}}
        assert _errors(data) != []
        assert _parse_coverage_json(data) is None

    def test_line_hits_wins_over_contradicting_covered_line(self) -> None:
        # line_hits records 14 as unhit; covered_lines also lists 14. line_hits
        # is authoritative → 14 stays uncovered, and the validator warns rather
        # than silently letting a false-covered through.
        data = {"files": {"a.py": {"line_hits": {"14": 0}, "covered_lines": [14]}}}
        assert _errors(data) == []
        assert _warnings(data) != []
        assert _parse_coverage_json(data) == {"a.py": {14: 0}}

    def test_out_of_range_are_dropped_not_kept(self) -> None:
        # Warnings claim "dropped" — the parser must actually drop, so the
        # index never carries a line < 1 or a negative hit count.
        for entry in (
            {"line_hits": {"-3": 5}},
            {"line_hits": {"5": -3}},
            {"covered_lines": [0]},
        ):
            data = {"files": {"a.py": entry}}
            assert _warnings(data) != [], entry
            assert _parse_coverage_json(data) == {"a.py": {}}, entry

    def test_empty_containers_warn_like_missing(self) -> None:
        for entry in ({}, {"line_hits": {}}, {"covered_lines": []}):
            data = {"files": {"a.py": entry}}
            assert _warnings(data) != [], entry
            assert _errors(data) == [], entry
