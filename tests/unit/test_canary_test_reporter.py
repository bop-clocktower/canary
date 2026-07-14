"""Unit tests for the canary-test-reporter skill scripts."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-test-reporter" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent
sys.path.insert(0, str(_SCRIPTS))


# ---------------------------------------------------------------------------
# Helpers shared across tasks
# ---------------------------------------------------------------------------

def _write(tmp_path: Path, data: object) -> Path:
    p = tmp_path / "results.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def _make_result(status: str, duration: int | None = None, error: str | None = None) -> dict:
    r: dict = {"status": status}
    if duration is not None:
        r["duration"] = duration
    if error:
        r["error"] = {"message": error}
    return r


def _make_test(title: str, status: str, results: list, location: dict | None = None) -> dict:
    t: dict = {"title": title, "status": status, "results": results}
    if location:
        t["location"] = location
    return t


def _make_spec(title: str, tests: list, location: dict | None = None) -> dict:
    s: dict = {"title": title, "tests": tests}
    if location:
        s["location"] = location
    return s


def _make_suite(title: str, specs: list | None = None, suites: list | None = None) -> dict:
    return {"title": title, "specs": specs or [], "suites": suites or []}


# ---------------------------------------------------------------------------
# Task 2: parse.py
# ---------------------------------------------------------------------------

import parse  # noqa: E402


def test_parse_missing_file_returns_empty_report(tmp_path):
    data = parse.parse_results(tmp_path / "nope.json")
    assert data.total == 0
    assert data.results == []


def test_parse_malformed_json_raises(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("not json", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        parse.parse_results(p)


def test_parse_non_object_toplevel_raises(tmp_path):
    with pytest.raises(ValueError, match="top-level value must be an object"):
        parse.parse_results(_write(tmp_path, [1, 2, 3]))


def test_parse_malformed_structure_raises(tmp_path):
    with pytest.raises(ValueError, match="unexpected structure"):
        parse.parse_results(_write(tmp_path, {"suites": "not-a-list"}))


def test_parse_passed_test(tmp_path):
    data = _write(tmp_path, {"suites": [_make_suite("root", specs=[
        _make_spec("loads", [_make_test("loads", "passed", [_make_result("passed", 123)])],
                   location={"file": "a.spec.ts", "line": 1}),
    ])]})
    report = parse.parse_results(data)
    assert report.total == 1
    assert report.passed == 1
    assert report.failed == 0
    r = report.results[0]
    assert r.status == "passed"
    assert r.error is None
    assert r.duration_ms == 123


def test_parse_failed_test_with_error(tmp_path):
    data = _write(tmp_path, {"suites": [_make_suite("root", specs=[
        _make_spec("auth", [
            _make_test("rejects bad pw", "unexpected",
                       [_make_result("unexpected", 500, "Expected 401, got 200")],
                       location={"file": "auth.spec.ts", "line": 42}),
        ], location={"file": "auth.spec.ts", "line": 1}),
    ])]})
    report = parse.parse_results(data)
    assert report.failed == 1
    r = report.results[0]
    assert r.status == "failed"
    assert r.error == "Expected 401, got 200"
    assert r.file == "auth.spec.ts"
    assert r.line == 42


def test_parse_flaky_test(tmp_path):
    # failed/unexpected with a passing retry → flaky (not counted as failure)
    data = _write(tmp_path, {"suites": [_make_suite("root", specs=[
        _make_spec("search", [
            _make_test("autocomplete", "unexpected",
                       [_make_result("unexpected", 200, "timeout"),
                        _make_result("passed", 180)]),
        ], location={"file": "search.spec.ts", "line": 17}),
    ])]})
    report = parse.parse_results(data)
    assert report.flaky == 1
    assert report.failed == 0
    assert report.results[0].status == "flaky"
    assert report.results[0].error is None  # flakes don't carry error


def test_parse_skipped_test(tmp_path):
    data = _write(tmp_path, {"suites": [_make_suite("root", specs=[
        _make_spec("slow", [_make_test("heavy", "skipped", [])]),
    ])]})
    report = parse.parse_results(data)
    assert report.skipped == 1
    assert report.results[0].status == "skipped"


def test_parse_duration_sum(tmp_path):
    data = _write(tmp_path, {"suites": [_make_suite("root", specs=[
        _make_spec("a", [_make_test("t1", "passed", [_make_result("passed", 100)])]),
        _make_spec("b", [_make_test("t2", "passed", [_make_result("passed", 250)])]),
    ])]})
    report = parse.parse_results(data)
    assert report.duration_ms == 350


def test_parse_nested_suites(tmp_path):
    inner = _make_suite("inner", specs=[
        _make_spec("logs in", [_make_test("logs in", "passed", [_make_result("passed", 10)])]),
    ])
    outer = _make_suite("outer", suites=[inner])
    data = _write(tmp_path, {"suites": [outer]})
    report = parse.parse_results(data)
    assert report.total == 1
    assert "outer" in report.results[0].title
    assert "inner" in report.results[0].title


def test_parse_counts_correct(tmp_path):
    specs = [
        _make_spec("p", [_make_test("p", "passed", [_make_result("passed")])]),
        _make_spec("f", [_make_test("f", "unexpected", [_make_result("unexpected", error="boom")])]),
        _make_spec("fl", [_make_test("fl", "unexpected",
                                     [_make_result("unexpected"), _make_result("passed")])]),
        _make_spec("s", [_make_test("s", "skipped", [])]),
    ]
    report = parse.parse_results(_write(tmp_path, {"suites": [_make_suite("r", specs=specs)]}))
    assert report.total == 4
    assert report.passed == 1
    assert report.failed == 1
    assert report.flaky == 1
    assert report.skipped == 1


def test_parse_strips_leading_banner(tmp_path):
    # Playwright sometimes emits non-JSON lines before the JSON blob
    p = tmp_path / "results.json"
    p.write_text('Playwright run\n{"suites": []}', encoding="utf-8")
    report = parse.parse_results(p)
    assert report.total == 0
