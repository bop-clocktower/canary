"""Tests for agent/guardian/delta_emitter.py — the api-delta.json v1 artifact."""

from __future__ import annotations

import json

from agent.guardian.delta_emitter import build_api_delta, write_api_delta
from agent.guardian.diff_extractor import ApiDiff, ChangeType, EndpointChange


def _diff_with_changes() -> ApiDiff:
    added = EndpointChange(
        path="/challenges/{id}/enroll",
        method="post",
        change_type=ChangeType.ADDED,
        after={"responses": {"200": {}}},
    )
    changed = EndpointChange(
        path="/rewards",
        method="get",
        change_type=ChangeType.CHANGED,
        before={"parameters": [{"name": "id"}], "responses": {"200": {"schema": {"a": 1}}}},
        after={"parameters": [{"name": "id"}, {"name": "q"}], "responses": {"200": {"schema": {"a": 2}}}},
    )
    return ApiDiff(added=[added], removed=[], changed=[changed])


def test_build_summary_counts_and_schema_version():
    delta = build_api_delta(_diff_with_changes(), sha="abc1234", suite="api", generated="2026-07-01T00:00:00Z")
    assert delta["schema_version"] == 1
    assert delta["sut"] == {"sha": "abc1234", "suite": "api"}
    assert delta["generated"] == "2026-07-01T00:00:00Z"
    assert delta["summary"] == {"added": 1, "removed": 0, "changed": 1, "total": 2}


def test_build_methods_upper_cased_and_paths_verbatim():
    delta = build_api_delta(_diff_with_changes(), sha="x", suite="api", generated="t")
    assert delta["endpoints"]["added"][0] == {"method": "POST", "path": "/challenges/{id}/enroll"}
    assert delta["endpoints"]["changed"][0]["method"] == "GET"
    assert delta["endpoints"]["changed"][0]["path"] == "/rewards"


def test_build_changed_carries_classified_changes():
    delta = build_api_delta(_diff_with_changes(), sha="x", suite="api", generated="t")
    # params + response both changed on /rewards, ordered by VALID_CHANGES
    assert delta["endpoints"]["changed"][0]["changes"] == ["params", "response"]


def test_build_empty_diff_total_zero():
    delta = build_api_delta(ApiDiff([], [], []), sha="x", suite="api", generated="t")
    assert delta["summary"]["total"] == 0
    assert delta["endpoints"] == {"added": [], "removed": [], "changed": []}


def test_write_round_trips(tmp_path):
    delta = build_api_delta(_diff_with_changes(), sha="x", suite="api", generated="t")
    out = tmp_path / "api-delta.json"
    write_api_delta(delta, str(out))
    assert json.loads(out.read_text()) == delta
