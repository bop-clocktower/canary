"""Unit tests for `canary guardian analyze --emit-diff`."""

from __future__ import annotations

import json

from typer.testing import CliRunner

from agent.guardian.cli import guardian_app

runner = CliRunner()

_BEFORE = {"openapi": "3.0.0", "paths": {"/members": {"get": {"operationId": "list"}}}}
_AFTER = {
    "openapi": "3.0.0",
    "paths": {
        "/members": {"get": {"operationId": "list"}},
        "/members/bulk": {"post": {"operationId": "bulk"}},
    },
}


def _write_specs(tmp_path):
    before = tmp_path / "before.json"
    after = tmp_path / "after.json"
    before.write_text(json.dumps(_BEFORE))
    after.write_text(json.dumps(_AFTER))
    return str(before), str(after)


def test_emit_diff_writes_contract_artifact(tmp_path):
    before, after = _write_specs(tmp_path)
    out = tmp_path / "api-delta.json"
    res = runner.invoke(
        guardian_app,
        ["analyze", "abc1234", "--spec-before", before, "--spec-after", after,
         "--suite", "api", "--emit-diff", str(out), "--dry-run"],
    )
    assert res.exit_code == 0
    assert out.exists()
    delta = json.loads(out.read_text())
    assert delta["schema_version"] == 1
    assert delta["sut"]["suite"] == "api"
    assert delta["summary"]["added"] == 1
    # method upper-cased, path verbatim
    assert delta["endpoints"]["added"][0] == {"method": "POST", "path": "/members/bulk"}


def test_without_emit_diff_no_file_written(tmp_path):
    before, after = _write_specs(tmp_path)
    out = tmp_path / "api-delta.json"
    res = runner.invoke(
        guardian_app,
        ["analyze", "abc1234", "--spec-before", before, "--spec-after", after, "--dry-run"],
    )
    assert res.exit_code == 0
    assert not out.exists()
