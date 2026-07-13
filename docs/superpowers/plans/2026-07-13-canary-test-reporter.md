# canary-test-reporter Implementation Plan

<!-- markdownlint-disable-file MD013 MD033 -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `canary-test-reporter`, a self-contained bundled skill that reads
a Playwright JSON results file and emits a Markdown report (stdout or file) and/or
a JSON artifact (file), exiting non-zero when any test failed.

**Architecture:** Five-file self-contained skill under
`agents/skills/claude-code/canary-test-reporter/scripts/` — a parser that
produces a `ReportData` object, a Markdown renderer, a JSON serializer, and a
CLI that composes them. Mirrors the `canary-fail-fast` pattern exactly. No
imports outside `scripts/`.

**Tech Stack:** Python 3.11+, stdlib only (`json`, `dataclasses`, `argparse`,
`datetime`, `pathlib`). pytest for tests.

## Global Constraints

- Self-contained: zero imports outside `agents/skills/claude-code/canary-test-reporter/scripts/`
- `sys.path.insert(0, str(Path(__file__).resolve().parent))` in `cli.py` makes sibling modules importable
- De-id: no proprietary client strings anywhere in `scripts/` or `SKILL.md`
- Skill name: `canary-test-reporter` throughout (prog name, SKILL.md frontmatter, test assertions)
- Exit code: `1` when `data.failed > 0`, `0` otherwise — flakes and skips never affect exit
- All tests in `tests/unit/test_canary_test_reporter.py`, no mocks, `tmp_path` fixtures only
- Branch: `feat/canary-test-reporter` off `main`

---

## File Map

| File | Role |
| --- | --- |
| `agents/skills/claude-code/canary-test-reporter/SKILL.md` | Skill manifest + prose docs |
| `agents/skills/claude-code/canary-test-reporter/scripts/__init__.py` | Empty package marker |
| `agents/skills/claude-code/canary-test-reporter/scripts/parse.py` | `TestResult`, `ReportData`, `parse_results()` |
| `agents/skills/claude-code/canary-test-reporter/scripts/render.py` | `render_markdown()` |
| `agents/skills/claude-code/canary-test-reporter/scripts/json_report.py` | `render_json()` |
| `agents/skills/claude-code/canary-test-reporter/scripts/cli.py` | `main()`, argument parsing, exit code |
| `tests/unit/test_canary_test_reporter.py` | All tests (built up across tasks) |

---

## Task 1: Branch + scaffold

**Files:**

- Create: `agents/skills/claude-code/canary-test-reporter/scripts/__init__.py`
- Create: `agents/skills/claude-code/canary-test-reporter/SKILL.md` (stub)
- Create: `tests/unit/test_canary_test_reporter.py` (imports + helpers only)

**Interfaces:**

- Produces: directory structure and test file skeleton consumed by all later tasks

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull
git checkout -b feat/canary-test-reporter
```

- [ ] **Step 2: Scaffold directories and empty init**

```bash
mkdir -p agents/skills/claude-code/canary-test-reporter/scripts
touch agents/skills/claude-code/canary-test-reporter/scripts/__init__.py
```

- [ ] **Step 3: Write SKILL.md stub** (full prose added in Task 6)

Create `agents/skills/claude-code/canary-test-reporter/SKILL.md`:

```markdown
---
name: canary-test-reporter
description: >
  Playwright JSON results → Markdown + JSON test report. Summarises passed,
  failed, flaky, and skipped counts with a per-failure error block. Exits
  non-zero when any test failed so the CI step fails on real failures.
cli: scripts/cli.py
---

# Canary Test Reporter

(Full docs added in final task.)
```

- [ ] **Step 4: Write test file skeleton**

Create `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 5: Verify test file imports cleanly**

```bash
python3 -c "import sys; sys.path.insert(0, 'tests/unit'); import test_canary_test_reporter; print('OK')"
```

Expected output: `OK`

- [ ] **Step 6: Commit scaffold**

```bash
git add agents/skills/claude-code/canary-test-reporter/ tests/unit/test_canary_test_reporter.py
git commit -m "chore(canary-test-reporter): scaffold skill directory + test skeleton"
```

---

## Task 2: `parse.py` — Full-fidelity Playwright JSON parser

**Files:**

- Create: `agents/skills/claude-code/canary-test-reporter/scripts/parse.py`
- Modify: `tests/unit/test_canary_test_reporter.py` (add parse tests)

**Interfaces:**

- Consumes: nothing (no imports outside stdlib)
- Produces:
  - `TestResult` dataclass — `title: str`, `status: str`, `file: str | None`, `line: int | None`, `duration_ms: int | None`, `error: str | None`
  - `ReportData` dataclass — `total: int`, `passed: int`, `failed: int`, `flaky: int`, `skipped: int`, `duration_ms: int`, `results: list[TestResult]`
  - `parse_results(results_path: Path) -> ReportData`

- [ ] **Step 1: Write the failing parse tests**

Append to `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "parse" -v 2>&1 | head -30
```

Expected: `ModuleNotFoundError: No module named 'parse'`

- [ ] **Step 3: Implement `parse.py`**

Create `agents/skills/claude-code/canary-test-reporter/scripts/parse.py`:

```python
"""Full-fidelity Playwright JSON parser (self-contained).

Walks nested suites/specs/tests and classifies each as passed, failed,
flaky, or skipped. A failed/unexpected test with a passing retry is
flaky and carries no error. Leading non-JSON banners are stripped before
parsing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class TestResult:
    __test__ = False  # prevent pytest collection
    title: str
    status: str  # "passed" | "failed" | "flaky" | "skipped"
    file: Optional[str] = None
    line: Optional[int] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None


@dataclass
class ReportData:
    total: int
    passed: int
    failed: int
    flaky: int
    skipped: int
    duration_ms: int
    results: List[TestResult]


def parse_results(results_path: Path) -> ReportData:
    if not results_path.exists():
        return ReportData(total=0, passed=0, failed=0, flaky=0,
                          skipped=0, duration_ms=0, results=[])

    text = results_path.read_text(encoding="utf-8")
    brace_at = text.find("{")
    if brace_at > 0:
        text = text[brace_at:]

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"results file is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("results file's top-level value must be an object")

    results: List[TestResult] = []
    try:
        for suite in data.get("suites", []) or []:
            _process_suite(suite, results, parent_path="", suite_file="")
    except (TypeError, AttributeError) as exc:
        raise ValueError(f"results file has an unexpected structure: {exc}") from exc

    passed = sum(1 for r in results if r.status == "passed")
    failed = sum(1 for r in results if r.status == "failed")
    flaky = sum(1 for r in results if r.status == "flaky")
    skipped = sum(1 for r in results if r.status == "skipped")
    total_ms = sum(r.duration_ms or 0 for r in results)

    return ReportData(
        total=len(results),
        passed=passed,
        failed=failed,
        flaky=flaky,
        skipped=skipped,
        duration_ms=total_ms,
        results=results,
    )


def _process_suite(
    suite: Dict[str, Any],
    results: List[TestResult],
    parent_path: str,
    suite_file: str,
) -> None:
    suite_title = suite.get("title", "")
    suite_path = f"{parent_path} > {suite_title}" if parent_path else suite_title
    current_file = suite.get("file") or suite_file

    for child in suite.get("suites", []) or []:
        _process_suite(child, results, suite_path, current_file)

    for spec in suite.get("specs", []) or []:
        spec_path = f"{suite_path} > {spec.get('title', '')}"
        spec_location = spec.get("location") or {}
        for test in spec.get("tests", []) or []:
            test_title = test.get("title") or spec.get("title", "")
            test_location = test.get("location") or {}
            test_results = test.get("results") or []
            raw_status = test.get("status", "unknown")

            if raw_status in ("skipped", "pending"):
                status = "skipped"
            elif raw_status in ("passed", "expected"):
                status = "passed"
            elif raw_status in ("failed", "unexpected"):
                has_passing_retry = any(
                    r.get("status") in ("passed", "expected") for r in test_results
                )
                status = "flaky" if has_passing_retry else "failed"
            else:
                status = "passed"

            error: Optional[str] = None
            duration: Optional[int] = None
            if test_results:
                last = test_results[-1]
                duration = last.get("duration")
                if status == "failed":
                    err = last.get("error") or {}
                    error = err.get("message")
                    if error is None:
                        errs = last.get("errors") or []
                        if errs:
                            error = errs[0].get("message")

            results.append(TestResult(
                title=f"{spec_path} > {test_title}",
                status=status,
                file=test_location.get("file") or spec_location.get("file") or current_file or None,
                line=test_location.get("line") or spec_location.get("line"),
                duration_ms=duration,
                error=error,
            ))
```

- [ ] **Step 4: Run parse tests**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "parse" -v
```

Expected: all parse tests PASS

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-test-reporter/scripts/parse.py \
        tests/unit/test_canary_test_reporter.py
git commit -m "feat(canary-test-reporter): parse.py — full-fidelity Playwright JSON parser"
```

---

## Task 3: `render.py` — Markdown renderer

**Files:**

- Create: `agents/skills/claude-code/canary-test-reporter/scripts/render.py`
- Modify: `tests/unit/test_canary_test_reporter.py` (add render tests)

**Interfaces:**

- Consumes: `from parse import ReportData, TestResult`
- Produces: `render_markdown(data: ReportData) -> str`

- [ ] **Step 1: Write the failing render tests**

Append to `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "render" -v 2>&1 | head -10
```

Expected: `ModuleNotFoundError: No module named 'render'`

- [ ] **Step 3: Implement `render.py`**

Create `agents/skills/claude-code/canary-test-reporter/scripts/render.py`:

```python
"""Markdown renderer for Playwright test results (self-contained, pure)."""
from __future__ import annotations

from parse import ReportData, TestResult  # noqa: F401 (TestResult used for type hints)

_ERROR_LINE_LIMIT = 10


def render_markdown(data: ReportData) -> str:
    parts: list[str] = ["# Test Report\n\n"]

    # Status line: "2 failed · 1 flaky · 14 passed · 1 skipped · 38 tests · 12.4s"
    chips: list[str] = []
    if data.failed:
        chips.append(f"**{data.failed} failed**")
    if data.flaky:
        chips.append(f"**{data.flaky} flaky**")
    if data.passed:
        chips.append(f"**{data.passed} passed**")
    if data.skipped:
        chips.append(f"**{data.skipped} skipped**")
    duration_s = data.duration_ms / 1000
    parts.append(" · ".join(chips) + f" · {data.total} tests · {duration_s:.1f}s\n")

    # Failed section
    failed = [r for r in data.results if r.status == "failed"]
    if failed:
        parts.append(f"\n## Failed ({len(failed)})\n")
        for r in failed:
            parts.append(f"\n### {r.title}\n")
            if r.file:
                loc = f"`{r.file}:{r.line}`" if r.line else f"`{r.file}`"
                parts.append(f"\n{loc}\n")
            if r.error:
                lines = r.error.splitlines()
                if len(lines) > _ERROR_LINE_LIMIT:
                    lines = lines[:_ERROR_LINE_LIMIT] + ["… (truncated)"]
                parts.append(f"\n```\n{chr(10).join(lines)}\n```\n")

    # Flaky section
    flaky = [r for r in data.results if r.status == "flaky"]
    if flaky:
        parts.append(f"\n## Flaky ({len(flaky)})\n")
        for r in flaky:
            loc = f"`{r.file}:{r.line}` — " if (r.file and r.line) else ""
            parts.append(f"\n- {loc}{r.title}\n")

    # Summary table
    parts.append("\n## Summary\n")
    parts.append("\n| Status | Count |\n| --- | --- |\n")
    parts.append(f"| Passed | {data.passed} |\n")
    parts.append(f"| Failed | {data.failed} |\n")
    parts.append(f"| Flaky | {data.flaky} |\n")
    parts.append(f"| Skipped | {data.skipped} |\n")
    parts.append(f"| **Total** | **{data.total}** |\n")

    return "".join(parts)
```

- [ ] **Step 4: Run render tests**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "render" -v
```

Expected: all render tests PASS

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-test-reporter/scripts/render.py \
        tests/unit/test_canary_test_reporter.py
git commit -m "feat(canary-test-reporter): render.py — Markdown report renderer"
```

---

## Task 4: `json_report.py` — JSON serializer

**Files:**

- Create: `agents/skills/claude-code/canary-test-reporter/scripts/json_report.py`
- Modify: `tests/unit/test_canary_test_reporter.py` (add json_report tests)

**Interfaces:**

- Consumes: `from parse import ReportData`
- Produces: `render_json(data: ReportData) -> str` (returns valid JSON string)

- [ ] **Step 1: Write the failing JSON tests**

Append to `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "json" -v 2>&1 | head -10
```

Expected: `ModuleNotFoundError: No module named 'json_report'`

- [ ] **Step 3: Implement `json_report.py`**

Create `agents/skills/claude-code/canary-test-reporter/scripts/json_report.py`:

```python
"""JSON serializer for Playwright test results (self-contained, pure)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from parse import ReportData


def render_json(data: ReportData) -> str:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    output = {
        "version": 1,
        "generated_at": generated_at,
        "summary": {
            "total": data.total,
            "passed": data.passed,
            "failed": data.failed,
            "flaky": data.flaky,
            "skipped": data.skipped,
            "duration_ms": data.duration_ms,
        },
        "results": [
            {
                "title": r.title,
                "status": r.status,
                "file": r.file,
                "line": r.line,
                "duration_ms": r.duration_ms,
                "error": r.error,
            }
            for r in data.results
        ],
    }
    return json.dumps(output, indent=2)
```

- [ ] **Step 4: Run JSON tests**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "json" -v
```

Expected: all JSON tests PASS

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-test-reporter/scripts/json_report.py \
        tests/unit/test_canary_test_reporter.py
git commit -m "feat(canary-test-reporter): json_report.py — JSON report serializer"
```

---

## Task 5: `cli.py` — Orchestration + exit code

**Files:**

- Create: `agents/skills/claude-code/canary-test-reporter/scripts/cli.py`
- Modify: `tests/unit/test_canary_test_reporter.py` (add CLI tests)

**Interfaces:**

- Consumes:
  - `parse_results(results_path: Path) -> ReportData` from `parse`
  - `render_markdown(data: ReportData) -> str` from `render`
  - `render_json(data: ReportData) -> str` from `json_report`
- Produces: `main(argv: list[str] | None = None) -> int`

- [ ] **Step 1: Write the failing CLI tests**

Append to `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "cli" -v 2>&1 | head -10
```

Expected: `ModuleNotFoundError: No module named 'cli'`

- [ ] **Step 3: Implement `cli.py`**

Create `agents/skills/claude-code/canary-test-reporter/scripts/cli.py`:

```python
#!/usr/bin/env python3
"""canary-test-reporter — Playwright JSON → Markdown + JSON report.

  --results <path>        required: Playwright JSON results file
  --markdown-out <path>   write Markdown report to file (stdout if neither flag given)
  --json-out <path>       write JSON report to file

Exit code: 1 when any test failed, else 0.

Invoked via `canary skills run canary-test-reporter -- --results <json>`.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make sibling modules importable by bare name (parse / render / json_report).
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-test-reporter",
        description="Playwright JSON results → Markdown + JSON test report.",
    )
    parser.add_argument("--results", required=True, metavar="PATH",
                        help="Playwright JSON results file.")
    parser.add_argument("--markdown-out", default=None, metavar="PATH",
                        help="Write Markdown report to file (default: stdout).")
    parser.add_argument("--json-out", default=None, metavar="PATH",
                        help="Write JSON report to file.")
    args = parser.parse_args(argv)

    results_path = Path(args.results)
    if not results_path.exists():
        print(
            f"canary-test-reporter: results file not found: {results_path}",
            file=sys.stderr,
        )
        return 1

    from parse import parse_results
    from render import render_markdown
    from json_report import render_json

    try:
        data = parse_results(results_path)
    except (OSError, ValueError) as exc:
        print(f"canary-test-reporter: {exc}", file=sys.stderr)
        return 1

    markdown = render_markdown(data)

    if args.markdown_out:
        Path(args.markdown_out).write_text(markdown, encoding="utf-8")
    elif not args.json_out:
        print(markdown, end="")

    if args.json_out:
        Path(args.json_out).write_text(render_json(data), encoding="utf-8")

    return 1 if data.failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run CLI tests**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "cli" -v
```

Expected: all CLI tests PASS

- [ ] **Step 5: Run full test suite**

```bash
pytest tests/unit/test_canary_test_reporter.py -v
```

Expected: all tests PASS, zero failures

- [ ] **Step 6: Commit**

```bash
git add agents/skills/claude-code/canary-test-reporter/scripts/cli.py \
        tests/unit/test_canary_test_reporter.py
git commit -m "feat(canary-test-reporter): cli.py — orchestration + exit code"
```

---

## Task 6: SKILL.md prose + de-id + discovery + roadmap

**Files:**

- Modify: `agents/skills/claude-code/canary-test-reporter/SKILL.md` (full prose)
- Modify: `tests/unit/test_canary_test_reporter.py` (de-id + discovery tests)
- Modify: `docs/roadmap.md` (mark Generic test reporter done)

**Interfaces:**

- Consumes: completed skill directory from Tasks 1–5
- Produces: shippable, documented, de-id'd skill

- [ ] **Step 1: Write de-id + discovery tests**

Append to `tests/unit/test_canary_test_reporter.py`:

```python
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
```

- [ ] **Step 2: Run de-id + discovery tests to verify they fail**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "discoverable or client_strings" -v 2>&1 | tail -15
```

Expected: `test_skill_is_discoverable_and_runnable` FAILS (skill not yet in registry path with full SKILL.md); `test_skill_dir_has_no_client_strings` PASSES (stub SKILL.md is clean).

- [ ] **Step 3: Write full SKILL.md**

Overwrite `agents/skills/claude-code/canary-test-reporter/SKILL.md`:

````markdown
---
name: canary-test-reporter
description: >
  Playwright JSON results → Markdown + JSON test report. Summarises passed,
  failed, flaky, and skipped counts with a per-failure error block and a
  summary table. Exits non-zero when any test failed so the CI step fails on
  real failures. Complements canary-fail-fast (which aborts early); this skill
  summarises the full run at the end.
cli: scripts/cli.py
---

# Canary Test Reporter

Turn a Playwright JSON results file into a human-readable **Markdown** report
and/or a machine-readable **JSON** artifact. Designed to run after the
Playwright step in CI (`if: always()`) and upload both files as job artifacts.

## Invocation

```bash
# Markdown to stdout:
canary skills run canary-test-reporter -- --results test-results/results.json

# Markdown to file:
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --markdown-out test-results/report.md

# JSON to file:
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --json-out test-results/report.json

# Both at once (recommended for CI):
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --markdown-out test-results/report.md \
  --json-out test-results/report.json
```

**Exit code:** `1` when any test failed; `0` otherwise. Flaky tests and
skipped tests never affect the exit code.

## Output formats

### Markdown

```text
# Test Report

**2 failed** · **1 flaky** · **14 passed** · **1 skipped** · 18 tests · 12.4s

## Failed (2)

### suite > spec > test title
`tests/auth.spec.ts:42`

```
Expected: 401
Received: 200
```

## Flaky (1)

- `tests/search.spec.ts:17` — search > autocomplete > debounce

## Summary

| Status | Count |
| --- | --- |
| Passed | 14 |
| Failed | 2 |
| Flaky | 1 |
| Skipped | 1 |
| **Total** | **18** |
```

### JSON

```json
{
  "version": 1,
  "generated_at": "2026-07-13T20:07:00Z",
  "summary": { "total": 18, "passed": 14, "failed": 2, "flaky": 1, "skipped": 1, "duration_ms": 12400 },
  "results": [
    { "title": "suite > spec > test", "status": "failed", "file": "tests/auth.spec.ts",
      "line": 42, "duration_ms": 1823, "error": "Expected: 401\nReceived: 200" }
  ]
}
```

The `version` field pins the contract for downstream tooling.
`results` includes **all** tests so external tools can compute their own views.

## CI wiring (GitHub Actions)

```yaml
- name: Run Playwright
  run: npx playwright test --reporter=json --output-file=test-results/results.json

- name: Test report
  if: always()
  run: |
    canary skills run canary-test-reporter -- \
      --results test-results/results.json \
      --markdown-out test-results/report.md \
      --json-out test-results/report.json

- name: Upload test report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: test-report
    path: test-results/report.*
```

## Related skills

- `canary-fail-fast` — aborts the run early and emits `::error` annotations;
  use with this skill for complete CI coverage (abort fast + summarise at end)
````

- [ ] **Step 4: Run discovery test**

```bash
pytest tests/unit/test_canary_test_reporter.py -k "discoverable or client_strings" -v
```

Expected: both PASS

- [ ] **Step 5: Update roadmap**

In `docs/roadmap.md`, find the `### Generic test reporter` entry and update:

```markdown
### Generic test reporter

- **Status:** done
- **Spec:** docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md
- **Summary:** DONE — shipped as the bundled executable skill
  `canary-test-reporter` at `agents/skills/claude-code/canary-test-reporter/`.
  Reads a Playwright JSON results file and emits a Markdown report (stdout or
  file via `--markdown-out`) and/or a JSON artifact (`--json-out`). Classifies
  all tests as passed/failed/flaky/skipped. Exits non-zero on any real failure;
  flakes do not affect exit code. Self-contained (bundles its own
  full-fidelity parser). Fully de-id'd. ~39 dedicated tests. JSON contract
  (`version: 1`) designed for future TCM integration. (refs:
  docs/superpowers/specs/2026-07-13-canary-test-reporter-design.md)
- **Blockers:** —
- **Plan:** docs/superpowers/plans/2026-07-13-canary-test-reporter.md
```

- [ ] **Step 6: Run full test suite one final time**

```bash
pytest tests/unit/test_canary_test_reporter.py -v
```

Expected: all ~39 tests PASS, zero failures

- [ ] **Step 7: Commit + push**

```bash
git add agents/skills/claude-code/canary-test-reporter/SKILL.md \
        tests/unit/test_canary_test_reporter.py \
        docs/roadmap.md
git commit -m "feat(canary-test-reporter): SKILL.md prose + de-id guard + roadmap update"
git push -u origin feat/canary-test-reporter
```
