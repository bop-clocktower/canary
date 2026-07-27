"""Unit tests for `canary guardian validate-coverage`.

Exit-code contract (so a producer can gate its CI on it):
  0 — valid (or valid with warnings, unless --strict)
  1 — contract errors (or warnings under --strict)
  2 — the file is missing or not JSON
"""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from agent.guardian.cli import guardian_app

runner = CliRunner()


def _write(tmp_path: Path, obj) -> str:
    p = tmp_path / "coverage.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return str(p)


def test_valid_file_exits_zero(tmp_path: Path) -> None:
    path = _write(tmp_path, {"files": {"a.py": {"line_hits": {"1": 2}}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path])
    assert result.exit_code == 0


def test_error_file_exits_one(tmp_path: Path) -> None:
    path = _write(tmp_path, {"files": ["a.py"]})  # files must be an object
    result = runner.invoke(guardian_app, ["validate-coverage", path])
    assert result.exit_code == 1


def test_warning_only_exits_zero_but_reports(tmp_path: Path) -> None:
    path = _write(tmp_path, {"files": {"a.py": {"covered_lines": [1, "x"]}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path])
    assert result.exit_code == 0
    assert "warning" in result.output.lower()


def test_warning_under_strict_exits_one(tmp_path: Path) -> None:
    path = _write(tmp_path, {"files": {"a.py": {"covered_lines": [1, "x"]}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path, "--strict"])
    assert result.exit_code == 1


def test_missing_file_exits_two(tmp_path: Path) -> None:
    result = runner.invoke(
        guardian_app, ["validate-coverage", str(tmp_path / "nope.json")]
    )
    assert result.exit_code == 2


def test_non_json_exits_two(tmp_path: Path) -> None:
    p = tmp_path / "coverage.json"
    p.write_text("not json {", encoding="utf-8")
    result = runner.invoke(guardian_app, ["validate-coverage", str(p)])
    assert result.exit_code == 2


def test_json_output_is_machine_readable(tmp_path: Path) -> None:
    path = _write(tmp_path, {"files": {"a.py": {"covered_lines": [1, "x"]}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path, "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["valid"] is True  # warnings don't invalidate
    assert any(p["severity"] == "warning" for p in payload["problems"])


def test_markup_in_path_key_does_not_corrupt_json(tmp_path: Path) -> None:
    # A producer-controlled path with console-markup-looking characters must not
    # be interpreted or corrupt the machine-readable output.
    path = _write(tmp_path, {"files": {"[red]evil[/red]": {"covered_lines": [1]}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path, "--json"])
    payload = json.loads(result.output)  # must parse — no markup stripping
    assert payload["valid"] is True


def test_markup_that_would_crash_parser_is_safe(tmp_path: Path) -> None:
    # "[/]" is an unbalanced closing tag that crashes Rich's markup parser if
    # not escaped. Human output path must survive it.
    path = _write(tmp_path, {"files": {"[/]": {}}})
    result = runner.invoke(guardian_app, ["validate-coverage", path])
    assert result.exit_code == 0  # only a warning (empty entry)
    assert result.exception is None


def test_deeply_nested_json_exits_two_not_crash(tmp_path: Path) -> None:
    p = tmp_path / "coverage.json"
    p.write_text("[" * 100000, encoding="utf-8")
    result = runner.invoke(guardian_app, ["validate-coverage", str(p)])
    assert result.exit_code == 2


def test_directory_path_exits_two(tmp_path: Path) -> None:
    result = runner.invoke(guardian_app, ["validate-coverage", str(tmp_path)])
    assert result.exit_code == 2
