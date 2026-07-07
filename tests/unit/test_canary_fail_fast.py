"""Unit tests for the canary-fail-fast skill scripts."""

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-fail-fast" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent
sys.path.insert(0, str(_SCRIPTS))

import parse  # noqa: E402
import failures  # noqa: E402
import fastfail_check  # noqa: E402
import digest  # noqa: E402
import cli  # noqa: E402
from agent.core.skill_registry import SkillRegistry  # noqa: E402


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


def test_cli_no_args_returns_1(capsys):
    assert cli.main([]) == 1
    assert "nothing to do" in capsys.readouterr().err


def test_cli_config_ok_returns_0(tmp_path, capsys):
    cfg = tmp_path / "playwright.config.ts"
    cfg.write_text("forbidOnly maxFailures retries", encoding="utf-8")
    assert cli.main(["--config", str(cfg)]) == 0
    assert "Fail-fast config OK." in capsys.readouterr().out


def test_cli_config_with_recs_still_returns_0(tmp_path, capsys):
    cfg = tmp_path / "playwright.config.ts"
    cfg.write_text("forbidOnly only", encoding="utf-8")
    assert cli.main(["--config", str(cfg)]) == 0
    assert "recommendations" in capsys.readouterr().out


def test_cli_results_missing_file_returns_1(tmp_path, capsys):
    assert cli.main(["--results", str(tmp_path / "nope.json")]) == 1
    assert "not found" in capsys.readouterr().err


def test_cli_results_malformed_returns_1_no_traceback(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert cli.main(["--results", str(bad)]) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_cli_results_with_failure_returns_1(tmp_path, capsys):
    data = {"suites": [{"title": "r", "specs": [
        {"title": "t", "location": {"file": "a.ts", "line": 1},
         "tests": [{"title": "t", "status": "failed",
                    "results": [{"status": "failed", "error": {"message": "boom"}}]}]},
    ]}]}
    p = tmp_path / "results.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    assert cli.main(["--results", str(p)]) == 1
    assert "1 failing test" in capsys.readouterr().out


def test_cli_results_no_failures_returns_0(tmp_path, capsys):
    p = tmp_path / "results.json"
    p.write_text(json.dumps({"suites": []}), encoding="utf-8")
    assert cli.main(["--results", str(p)]) == 0
    assert "0 failing" in capsys.readouterr().out


def test_cli_results_unreadable_returns_1(tmp_path, capsys):
    # An existing path that is not a readable file (a directory) triggers the
    # OSError branch — must exit 1 cleanly, not raise a traceback.
    d = tmp_path / "a_dir_results.json"
    d.mkdir()
    assert cli.main(["--results", str(d)]) == 1
    assert "canary-fail-fast:" in capsys.readouterr().err


def test_cli_config_recs_and_results_failure_returns_digest_code(tmp_path, capsys):
    # Config audit with recommendations must NOT zero out the digest's exit code:
    # combined exit == digest exit (1 here, because there is a real failure).
    cfg = tmp_path / "playwright.config.ts"
    cfg.write_text("forbidOnly only", encoding="utf-8")  # missing knobs → recs
    data = {"suites": [{"title": "r", "specs": [
        {"title": "t", "location": {"file": "a.ts", "line": 1},
         "tests": [{"title": "t", "status": "failed",
                    "results": [{"status": "failed", "error": {"message": "boom"}}]}]},
    ]}]}
    res = tmp_path / "results.json"
    res.write_text(json.dumps(data), encoding="utf-8")
    assert cli.main(["--config", str(cfg), "--results", str(res)]) == 1
    out = capsys.readouterr().out
    assert "recommendations" in out and "1 failing test" in out


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-fail-fast" in skills
    assert skills["canary-fail-fast"].is_executable


def test_skill_dir_has_no_client_strings():
    banned = ("capillary", "capwell")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} in {path}"
