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
