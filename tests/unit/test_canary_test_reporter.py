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
