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
