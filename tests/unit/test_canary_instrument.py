"""Unit tests for the canary-instrument skill scripts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-instrument" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent

# Clear cached modules from other skills' test files to avoid namespace
# collision in a full-suite pytest run (canary-fail-fast and
# canary-test-reporter each ship their own `cli` module).
for _mod in ["run_types", "span_reader", "cli"]:
    sys.modules.pop(_mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import run_types  # noqa: E402


def test_run_artifact_to_dict_has_no_coverage_or_run_id_keys():
    artifact = run_types.RunArtifact(
        schema_version=1,
        suite_type="e2e_ui",
        generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=0, by_test=[]),
    )
    d = artifact.to_dict()
    assert "coverage" not in d
    assert "canary_run_id" not in d
    assert d["schema_version"] == 1
    assert d["suite_type"] == "e2e_ui"


def test_run_artifact_to_dict_serializes_nested_requests():
    req = run_types.RequestSpan(
        method="GET", url="http://localhost:3000/users/1", route="/users/:id",
        status=200, duration_ms=12.4, span_id="def456", started_at="2026-07-15T18:00:01+00:00",
    )
    tt = run_types.TestTrace(
        test_id="users-spec:1", test_title="lists users", test_file="tests/users.spec.ts",
        trace_id="abc123", outcome="passed", requests=[req],
    )
    artifact = run_types.RunArtifact(
        schema_version=1, suite_type="", generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=1, by_test=[tt]),
    )
    d = artifact.to_dict()
    assert d["trace"]["spans_total"] == 1
    row = d["trace"]["by_test"][0]
    assert row["test_id"] == "users-spec:1" and row["outcome"] == "passed"
    assert row["requests"][0]["method"] == "GET"
    assert row["requests"][0]["status"] == 200


def test_run_artifact_to_dict_is_json_serializable():
    artifact = run_types.RunArtifact(
        schema_version=1, suite_type="api", generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=0, by_test=[]),
    )
    # Round-trips cleanly — this is exactly what cli.py writes to disk.
    text = json.dumps(artifact.to_dict())
    assert json.loads(text)["suite_type"] == "api"


def test_test_trace_requests_defaults_to_empty_list():
    tt = run_types.TestTrace(
        test_id="__setup__", test_title="", test_file="", trace_id="", outcome="",
    )
    assert tt.requests == []


def test_trace_by_test_defaults_to_empty_list():
    assert run_types.Trace(spans_total=0).by_test == []


import span_reader  # noqa: E402


def _span(trace_id, span_id, *, attrs=None, duration_ms=1.0):
    return {
        "traceId": trace_id,
        "spanId": span_id,
        "parentSpanId": None,
        "name": "span",
        "startTime": "2026-07-15T18:00:01+00:00",
        "endTime": "2026-07-15T18:00:01+00:00",
        "duration_ms": duration_ms,
        "attributes": attrs or {},
    }


def _root_span(trace_id, span_id, *, test_id, title, file, outcome="passed"):
    return _span(trace_id, span_id, attrs={
        "test.id": test_id, "test.title": title, "test.file": file, "test.outcome": outcome,
    })


def _http_span(trace_id, span_id, *, method="GET", url="http://x/1", route="/x/:id",
                status=200, duration_ms=12.4):
    return _span(trace_id, span_id, attrs={
        "http.method": method, "http.url": url, "http.route": route,
        "http.status_code": status,
    }, duration_ms=duration_ms)


def _write_jsonl(path, spans):
    path.write_text("\n".join(json.dumps(s) for s in spans) + "\n", encoding="utf-8")


def test_missing_spans_dir_returns_empty_trace(tmp_path):
    trace = span_reader.read_traces(tmp_path / "does-not-exist")
    assert trace.spans_total == 0 and trace.by_test == []


def test_empty_spans_dir_returns_empty_trace(tmp_path):
    trace = span_reader.read_traces(tmp_path)  # exists, no *.jsonl files
    assert trace.spans_total == 0 and trace.by_test == []


def test_http_child_attaches_to_test_root(tmp_path):
    spans = [
        _root_span("t1", "s1", test_id="users-spec:1", title="lists users", file="tests/users.spec.ts"),
        _http_span("t1", "s2"),
    ]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1
    assert len(trace.by_test) == 1
    tt = trace.by_test[0]
    assert tt.test_id == "users-spec:1" and tt.outcome == "passed"
    assert len(tt.requests) == 1
    assert tt.requests[0].method == "GET" and tt.requests[0].status == 200


def test_rootless_trace_buckets_under_setup(tmp_path):
    spans = [_http_span("t2", "s1", url="http://x/health")]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1
    assert len(trace.by_test) == 1
    assert trace.by_test[0].test_id == "__setup__"
    assert trace.by_test[0].requests[0].url == "http://x/health"


def test_root_span_itself_is_not_counted_as_a_request(tmp_path):
    spans = [_root_span("t1", "s1", test_id="a:1", title="a", file="a.spec.ts")]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 0
    assert trace.by_test[0].requests == []


def test_multi_worker_files_merge_without_collision(tmp_path):
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2", url="http://x/a"),
    ])
    _write_jsonl(tmp_path / "otel-spans.1.jsonl", [
        _root_span("t2", "s1", test_id="b:1", title="test b", file="b.spec.ts"),
        _http_span("t2", "s2", url="http://x/b"),
    ])
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 2
    assert {tt.test_id for tt in trace.by_test} == {"a:1", "b:1"}
    # spanId "s1"/"s2" repeat across workers but traceId differs — no collision.
    urls = {req.url for tt in trace.by_test for req in tt.requests}
    assert urls == {"http://x/a", "http://x/b"}


def test_reconciliation_holds_across_setup_and_test_buckets(tmp_path):
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
        _http_span("t1", "s3"),
        _http_span("t3", "s1"),  # rootless -> __setup__
    ])
    trace = span_reader.read_traces(tmp_path)
    total_requests = sum(len(tt.requests) for tt in trace.by_test)
    assert trace.spans_total == total_requests == 3
    setup = next(tt for tt in trace.by_test if tt.test_id == "__setup__")
    assert len(setup.requests) == 1


def test_malformed_torn_line_is_skipped_not_raised(tmp_path):
    good = [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
    ]
    path = tmp_path / "otel-spans.0.jsonl"
    text = "\n".join(json.dumps(s) for s in good) + "\n"
    text += '{"traceId": "t1", "spanId": "s3", "attributes": {"http.method"'  # torn, no error raised
    path.write_text(text, encoding="utf-8")

    trace = span_reader.read_traces(tmp_path)  # must not raise
    assert trace.spans_total == 1
    assert trace.by_test[0].test_id == "a:1"


def test_blank_lines_between_spans_are_ignored(tmp_path):
    path = tmp_path / "otel-spans.0.jsonl"
    spans = [_root_span("t1", "s1", test_id="a:1", title="a", file="a.spec.ts"), _http_span("t1", "s2")]
    path.write_text("\n\n".join(json.dumps(s) for s in spans) + "\n\n", encoding="utf-8")
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1


import cli  # noqa: E402


def test_cli_writes_run_json_with_correct_shape(tmp_path, capsys):
    spans_dir = tmp_path / "spans"
    spans_dir.mkdir()
    _write_jsonl(spans_dir / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
    ])
    out_dir = tmp_path / "out"
    rc = cli.main(["--spans", str(spans_dir), "--output", str(out_dir), "--suite-type", "e2e_ui"])
    assert rc == 0
    run_json = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
    assert run_json["schema_version"] == 1
    assert run_json["suite_type"] == "e2e_ui"
    assert "coverage" not in run_json and "canary_run_id" not in run_json
    assert run_json["trace"]["spans_total"] == 1


def test_cli_creates_missing_output_dir(tmp_path):
    out_dir = tmp_path / "nested" / "out"
    assert not out_dir.exists()
    rc = cli.main(["--spans", str(tmp_path / "no-spans"), "--output", str(out_dir)])
    assert rc == 0
    assert (out_dir / "run.json").exists()


def test_cli_missing_spans_dir_is_not_a_failure(tmp_path):
    rc = cli.main(["--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out")])
    assert rc == 0
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["trace"] == {"spans_total": 0, "by_test": []}


def test_cli_suite_type_defaults_to_empty_string(tmp_path):
    cli.main(["--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out")])
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["suite_type"] == ""


def test_cli_suite_type_accepts_arbitrary_string_no_enum(tmp_path):
    rc = cli.main([
        "--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out"),
        "--suite-type", "totally-made-up-value",
    ])
    assert rc == 0
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["suite_type"] == "totally-made-up-value"


def test_cli_spans_path_is_a_file_not_dir_fails(tmp_path, capsys):
    bad_spans = tmp_path / "spans-is-a-file"
    bad_spans.write_text("oops", encoding="utf-8")
    rc = cli.main(["--spans", str(bad_spans), "--output", str(tmp_path / "out")])
    assert rc == 1
    assert "not a directory" in capsys.readouterr().err


def test_cli_missing_required_flags_errors(capsys):
    with pytest.raises(SystemExit):
        cli.main([])


def test_skill_dir_has_no_client_strings():
    # Split string literals so this file does not itself contain the
    # proprietary tokens it guards against. Scans .py/.md AND .mjs/.ts —
    # the repo-wide guard (scripts/check_removed_symbols.py) does not cover
    # .mjs/.ts, so this skill's own test is the only guard for
    # otel_bootstrap/*.
    banned = ("capi" "llary", "loop" "back", "op" "tum", "cap" "well")
    scanned_suffixes = (".py", ".md", ".mjs", ".ts")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in scanned_suffixes:
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} found in {path}"


from agent.core.skill_registry import SkillRegistry  # noqa: E402


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-instrument" in skills
    assert skills["canary-instrument"].is_executable
