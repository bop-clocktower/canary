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
import failures  # noqa: E402
import fastfail_check  # noqa: E402
import digest  # noqa: E402


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
    result = parse.parse_failures(_write(tmp_path, data))
    assert len(result) == 1
    f = result[0]
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
    result = parse.parse_failures(_write(tmp_path, data))
    assert result[0].error == "from-array"


def test_categorize_none_is_other():
    assert failures.categorize_failure(None) == "other"
    assert failures.categorize_failure("") == "other"


@pytest.mark.parametrize("msg,cat", [
    ("ZodError: invalid_type expected string", "schema"),
    ("Request failed with status 401 Unauthorized", "auth"),
    ("connect ECONNREFUSED 127.0.0.1:5432", "network"),
    ("Timeout of 30000ms exceeded", "timeout"),
    ("500 Internal Server Error", "server"),
    ("404 Not Found", "client"),
    ("something totally unrecognized", "other"),
])
def test_categorize_matches_expected(msg, cat):
    assert failures.categorize_failure(msg) == cat


def test_categorize_order_schema_beats_status_code():
    # A schema error that also mentions a 404 must classify as schema (rules
    # are ordered so status-code patterns don't swallow schema signals).
    assert failures.categorize_failure("ZodError at path \"x\"; server returned 404") == "schema"


def test_check_all_present_empty():
    text = "forbidOnly: true, maxFailures: 10, retries: 2"
    assert fastfail_check.check_config(text) == []


def test_check_missing_one_flags_it():
    text = "forbidOnly: true, maxFailures: 10"  # no retries
    recs = fastfail_check.check_config(text)
    assert len(recs) == 1 and "retries" in recs[0]


def test_check_missing_all_flags_three():
    assert len(fastfail_check.check_config("")) == 3


def _fail(title, error, file=None, line=None):
    return parse.Failure(title=title, status="failed", file=file, line=line, error=error)


def test_digest_no_failures_exit_zero():
    d = digest.build_digest([])
    assert d.exit_code == 0 and d.annotations == [] and "0 failing" in d.text


def test_digest_singular_vs_plural():
    assert "1 failing test " in digest.build_digest([_fail("t", "boom")]).text + " "
    assert "2 failing tests" in digest.build_digest([_fail("a", "x"), _fail("b", "y")]).text


def test_digest_groups_by_category_and_exits_one():
    d = digest.build_digest([_fail("t1", "ZodError bad"), _fail("t2", "401 Unauthorized")])
    assert d.exit_code == 1
    assert "schema (1):" in d.text and "auth (1):" in d.text


def test_digest_annotation_includes_location():
    d = digest.build_digest([_fail("logs in", "boom", file="login.spec.ts", line=12)])
    assert d.annotations[0].startswith("::error file=login.spec.ts,line=12,title=Test failure::")
    assert "logs in" in d.annotations[0]


def test_digest_annotation_omits_absent_location():
    ann = digest.build_digest([_fail("no-loc", "boom")]).annotations[0]
    assert "file=" not in ann and "line=" not in ann
    assert ann.startswith("::error title=Test failure::")
