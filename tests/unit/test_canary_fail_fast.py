"""Unit tests for the canary-fail-fast skill scripts."""

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-fail-fast" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS))

import parse  # noqa: E402


def _write(tmp_path, data) -> Path:
    p = tmp_path / "results.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def _spec(title, tests):
    return {"title": title, "location": {"file": "a.spec.ts", "line": 7}, "tests": tests}


def test_parse_missing_file_returns_empty(tmp_path):
    assert parse.parse_failures(tmp_path / "nope.json") == []


def test_parse_malformed_json_raises(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("not json", encoding="utf-8")
    with pytest.raises(ValueError):
        parse.parse_failures(p)


def test_parse_non_object_toplevel_raises(tmp_path):
    p = _write(tmp_path, [1, 2, 3])
    with pytest.raises(ValueError):
        parse.parse_failures(p)


def test_parse_extracts_failure_with_location_and_error(tmp_path):
    data = {"suites": [{"title": "root", "specs": [
        _spec("logs in", [{"title": "logs in", "status": "unexpected",
              "location": {"file": "login.spec.ts", "line": 12},
              "results": [{"status": "unexpected", "error": {"message": "boom"}}]}]),
    ]}]}
    failures = parse.parse_failures(_write(tmp_path, data))
    assert len(failures) == 1
    f = failures[0]
    assert f.title == "root > logs in > logs in"
    assert f.file == "login.spec.ts" and f.line == 12
    assert f.error == "boom"


def test_parse_flaky_is_excluded(tmp_path):
    data = {"suites": [{"title": "root", "specs": [
        _spec("flaky", [{"title": "flaky", "status": "failed",
              "results": [{"status": "failed", "error": {"message": "x"}},
                          {"status": "passed"}]}]),
    ]}]}
    assert parse.parse_failures(_write(tmp_path, data)) == []


def test_parse_error_falls_back_to_errors_array(tmp_path):
    data = {"suites": [{"title": "r", "specs": [
        _spec("t", [{"title": "t", "status": "failed",
              "results": [{"status": "failed", "errors": [{"message": "from-array"}]}]}]),
    ]}]}
    failures = parse.parse_failures(_write(tmp_path, data))
    assert failures[0].error == "from-array"
