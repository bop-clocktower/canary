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

# Clear cached modules from other tests to avoid namespace collision in pytest
for mod in ["parse", "render", "json_report", "cli", "failures", "fastfail_check", "digest"]:
    sys.modules.pop(mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import parse
import render
import json_report
import cli


@pytest.fixture(autouse=True)
def _isolate_namespace():
    if str(_SCRIPTS) in sys.path:
        sys.path.remove(str(_SCRIPTS))
    sys.path.insert(0, str(_SCRIPTS))

    import importlib
    global parse, render, json_report, cli
    for mod in ["parse", "render", "json_report", "cli"]:
        sys.modules.pop(mod, None)
        m = importlib.import_module(mod)
        if mod == "parse":
            parse = m
        elif mod == "render":
            render = m
        elif mod == "json_report":
            json_report = m
        elif mod == "cli":
            cli = m




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


# ---------------------------------------------------------------------------
# Task 3: render.py
# ---------------------------------------------------------------------------

import render  # noqa: E402


def _make_report(passed=0, failed=0, flaky=0, skipped=0, results=None, duration_ms=0):
    """Build a ReportData without going through parse_results."""
    return parse.ReportData(
        total=passed + failed + flaky + skipped,
        passed=passed,
        failed=failed,
        flaky=flaky,
        skipped=skipped,
        duration_ms=duration_ms,
        results=results or [],
    )


def _failed_result(title="suite > spec > test", file="a.spec.ts", line=1, error="boom"):
    return parse.TestResult(title=title, status="failed", file=file, line=line, error=error)


def _passed_result(title="suite > spec > ok", duration_ms=100):
    return parse.TestResult(title=title, status="passed", duration_ms=duration_ms)


def _flaky_result(title="suite > spec > flaky", file="b.spec.ts", line=5):
    return parse.TestResult(title=title, status="flaky", file=file, line=line)


def test_render_starts_with_h1(tmp_path):
    md = render.render_markdown(_make_report(passed=1, results=[_passed_result()]))
    assert md.startswith("# Test Report")


def test_render_status_line_shows_counts():
    md = render.render_markdown(_make_report(
        passed=14, failed=2, flaky=1, skipped=1, duration_ms=12400,
        results=[_failed_result(), _failed_result("s>s>t2"), _flaky_result(),
                 _passed_result()] + [_passed_result(f"s>s>p{i}") for i in range(13)] +
                [parse.TestResult(title="s>s>sk", status="skipped")],
    ))
    assert "2" in md and "failed" in md.lower()
    assert "14" in md and "passed" in md.lower()
    assert "1" in md and "flaky" in md.lower()
    assert "12.4s" in md


def test_render_failed_section_present():
    r = _failed_result(title="auth > login > rejects bad pw",
                       file="auth.spec.ts", line=42, error="Expected 401")
    md = render.render_markdown(_make_report(failed=1, results=[r]))
    assert "## Failed" in md
    assert "auth > login > rejects bad pw" in md
    assert "auth.spec.ts:42" in md
    assert "Expected 401" in md


def test_render_failed_error_in_code_block():
    r = _failed_result(error="line one\nline two")
    md = render.render_markdown(_make_report(failed=1, results=[r]))
    assert "```" in md
    assert "line one" in md
    assert "line two" in md


def test_render_error_truncated_at_10_lines():
    long_error = "\n".join(f"line {i}" for i in range(15))
    r = _failed_result(error=long_error)
    md = render.render_markdown(_make_report(failed=1, results=[r]))
    assert "truncated" in md
    assert "line 9" in md
    assert "line 10" not in md


def test_render_flaky_section_present():
    r = _flaky_result(title="search > auto > debounce", file="s.spec.ts", line=17)
    md = render.render_markdown(_make_report(flaky=1, results=[r]))
    assert "## Flaky" in md
    assert "search > auto > debounce" in md


def test_render_flaky_no_error_detail():
    # Flaky tests must not include any error block
    r = parse.TestResult(title="s>s>t", status="flaky", file="f.ts", line=1)
    md = render.render_markdown(_make_report(flaky=1, results=[r]))
    assert "```" not in md


def test_render_no_failed_section_when_zero():
    md = render.render_markdown(_make_report(passed=5,
                                             results=[_passed_result(f"s>s>p{i}") for i in range(5)]))
    assert "## Failed" not in md


def test_render_no_flaky_section_when_zero():
    md = render.render_markdown(_make_report(passed=1, results=[_passed_result()]))
    assert "## Flaky" not in md


def test_render_summary_table_present():
    md = render.render_markdown(_make_report(
        passed=2, failed=1, results=[_failed_result(), _passed_result(), _passed_result("s>s>p2")],
    ))
    assert "## Summary" in md
    assert "Passed" in md
    assert "Failed" in md
    assert "Total" in md


def test_render_all_pass_report():
    md = render.render_markdown(_make_report(
        passed=3, duration_ms=3000,
        results=[_passed_result(f"s>s>p{i}", 1000) for i in range(3)],
    ))
    assert "## Failed" not in md
    assert "3.0s" in md


# ---------------------------------------------------------------------------
# Task 4: json_report.py
# ---------------------------------------------------------------------------

import json_report  # noqa: E402


def test_json_is_valid_json():
    report = _make_report(passed=1, results=[_passed_result()])
    out = json_report.render_json(report)
    parsed = json.loads(out)  # must not raise
    assert isinstance(parsed, dict)


def test_json_version_is_1():
    out = json.loads(json_report.render_json(_make_report()))
    assert out["version"] == 1


def test_json_generated_at_iso8601():
    out = json.loads(json_report.render_json(_make_report()))
    pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
    assert pattern.match(out["generated_at"]), f"bad format: {out['generated_at']}"


def test_json_summary_fields():
    report = _make_report(passed=3, failed=1, flaky=1, skipped=1, duration_ms=5000,
                          results=[_failed_result(), _flaky_result(),
                                   _passed_result(), _passed_result("s>s>p2"),
                                   _passed_result("s>s>p3"),
                                   parse.TestResult(title="s>s>sk", status="skipped")])
    out = json.loads(json_report.render_json(report))
    s = out["summary"]
    assert s["total"] == 6
    assert s["passed"] == 3
    assert s["failed"] == 1
    assert s["flaky"] == 1
    assert s["skipped"] == 1
    assert s["duration_ms"] == 5000


def test_json_results_all_statuses():
    results = [
        _passed_result("s>s>p"),
        _failed_result("s>s>f"),
        _flaky_result("s>s>fl"),
        parse.TestResult(title="s>s>sk", status="skipped"),
    ]
    report = _make_report(passed=1, failed=1, flaky=1, skipped=1, results=results)
    out = json.loads(json_report.render_json(report))
    statuses = {r["status"] for r in out["results"]}
    assert statuses == {"passed", "failed", "flaky", "skipped"}


def test_json_error_null_for_passed():
    report = _make_report(passed=1, results=[_passed_result()])
    out = json.loads(json_report.render_json(report))
    assert out["results"][0]["error"] is None


def test_json_results_include_all_fields():
    r = _failed_result(title="s > t", file="f.spec.ts", line=7, error="kaboom")
    report = _make_report(failed=1, results=[r])
    out = json.loads(json_report.render_json(report))
    result = out["results"][0]
    assert result["title"] == "s > t"
    assert result["status"] == "failed"
    assert result["file"] == "f.spec.ts"
    assert result["line"] == 7
    assert result["error"] == "kaboom"


# ---------------------------------------------------------------------------
# Task 5: cli.py
# ---------------------------------------------------------------------------

import cli  # noqa: E402


def _results_file(tmp_path: Path, passed: int = 0, failed: int = 0) -> Path:
    """Write a minimal results.json with the requested pass/fail counts."""
    specs = []
    for i in range(passed):
        specs.append(_make_spec(f"p{i}", [
            _make_test(f"p{i}", "passed", [_make_result("passed", 100)],
                       location={"file": "p.spec.ts", "line": i + 1}),
        ]))
    for i in range(failed):
        specs.append(_make_spec(f"f{i}", [
            _make_test(f"f{i}", "unexpected",
                       [_make_result("unexpected", 200, "boom")],
                       location={"file": "f.spec.ts", "line": i + 1}),
        ]))
    return _write(tmp_path, {"suites": [_make_suite("root", specs=specs)]})


def test_cli_missing_results_exits_nonzero(tmp_path, capsys):
    # --results is required; omitting it makes argparse exit with code 2
    with pytest.raises(SystemExit) as exc_info:
        cli.main([])
    assert exc_info.value.code != 0


def test_cli_results_file_not_found_exits_1(tmp_path, capsys):
    assert cli.main(["--results", str(tmp_path / "nope.json")]) == 1
    assert "not found" in capsys.readouterr().err


def test_cli_exit_0_on_all_pass(tmp_path, capsys):
    p = _results_file(tmp_path, passed=3)
    assert cli.main(["--results", str(p)]) == 0


def test_cli_exit_1_on_failures(tmp_path, capsys):
    p = _results_file(tmp_path, failed=2)
    assert cli.main(["--results", str(p)]) == 1


def test_cli_markdown_to_stdout_default(tmp_path, capsys):
    p = _results_file(tmp_path, passed=1)
    cli.main(["--results", str(p)])
    out = capsys.readouterr().out
    assert "# Test Report" in out


def test_cli_markdown_out_writes_file(tmp_path, capsys):
    p = _results_file(tmp_path, passed=2)
    out_path = tmp_path / "report.md"
    cli.main(["--results", str(p), "--markdown-out", str(out_path)])
    assert out_path.exists()
    assert "# Test Report" in out_path.read_text(encoding="utf-8")
    # nothing on stdout when writing to file
    assert capsys.readouterr().out == ""


def test_cli_json_out_writes_file(tmp_path):
    p = _results_file(tmp_path, passed=1)
    out_path = tmp_path / "report.json"
    cli.main(["--results", str(p), "--json-out", str(out_path)])
    assert out_path.exists()
    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["summary"]["passed"] == 1


def test_cli_both_flags_write_both_files(tmp_path):
    p = _results_file(tmp_path, passed=1, failed=1)
    md_path = tmp_path / "r.md"
    json_path = tmp_path / "r.json"
    code = cli.main(["--results", str(p),
                     "--markdown-out", str(md_path),
                     "--json-out", str(json_path)])
    assert md_path.exists() and json_path.exists()
    assert "# Test Report" in md_path.read_text(encoding="utf-8")
    assert json.loads(json_path.read_text(encoding="utf-8"))["version"] == 1
    assert code == 1  # failed > 0


def test_cli_json_only_no_stdout(tmp_path, capsys):
    # --json-out alone → no markdown on stdout
    p = _results_file(tmp_path, passed=1)
    out_path = tmp_path / "r.json"
    cli.main(["--results", str(p), "--json-out", str(out_path)])
    assert capsys.readouterr().out == ""


def test_cli_malformed_results_exits_1(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert cli.main(["--results", str(bad)]) == 1
    assert "canary-test-reporter:" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Task 6: SKILL.md + de-id + discovery
# ---------------------------------------------------------------------------

from agent.core.skill_registry import SkillRegistry  # noqa: E402


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-test-reporter" in skills
    assert skills["canary-test-reporter"].is_executable


def test_skill_dir_has_no_client_strings():
    # String literals are split so this file does not itself contain the
    # proprietary tokens it guards against.
    banned = ("capi" "llary", "cap" "well")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} found in {path}"
