# Canary Fail-Fast Implementation Plan

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: the writing-plans format uses long
     command/prose lines and label-then-list blocks (**Files:** followed by a
     list). Line-length and blanks-around-lists are relaxed for this working
     doc, matching the roadmap's MD013 disable. -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `canary-fail-fast`, a self-contained bundled executable skill that audits Playwright fail-fast config and prints a loud, categorized failure digest with GitHub `::error` annotations.

**Architecture:** A skill directory at `agents/skills/claude-code/canary-fail-fast/` with a `scripts/` package of five small, pure-where-possible modules plus a thin `cli.py`. No dependency on any other skill or `agent/` module — a de-id'd port of the private overlay's fail-fast skill, with the shared parser reduced to a failures-only local copy.

**Tech Stack:** Python 3.13/3.14, `argparse`, `re`, `dataclasses`, pytest. Discovered/run by the existing `SkillRegistry` (`cli:` frontmatter + `canary skills run`).

## Global Constraints

- **Self-contained:** no imports outside the skill's own `scripts/` dir (no overlay test-reports module, no `agent.reports`).
- **No client strings:** the overlay's client/company identifiers (per the repo denylist) and the old skill name must not appear in any shipped file (case-insensitive). Enforced by a test.
- **CLI surface:** flags are exactly `--results PATH` and `--config PATH`; at least one required.
- **Exit contract:** config audit contributes exit 0 always; digest exits 1 on any real (non-flaky) failure, else 0; combined = digest code.
- **Flaky rule:** a `failed`/`unexpected` test with any passing (`passed`/`expected`) retry is flaky and excluded from failures.
- **Categorizer:** the regex rule list and its order are ported verbatim (order is load-bearing).
- **Module naming:** no module named `types.py` (shadows stdlib); `Failure` lives in `parse.py`.
- **Docs:** `SKILL.md` must pass markdownlint (the repo pre-commit hook enforces it).

**Test import convention:** skill scripts are not a package on the default path. `tests/unit/test_canary_fail_fast.py` inserts the skill `scripts/` dir at `sys.path[0]` once, then imports modules by bare name — the same resolution `cli.py` uses at runtime, so intra-module imports (`from failures import …`) work identically.

---

### Task 1: `parse.py` — `Failure` + `parse_failures`

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/__init__.py` (empty)
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/parse.py`
- Test: `tests/unit/test_canary_fail_fast.py`

**Interfaces:**
- Produces: `Failure(title: str, status: str, file: str|None=None, line: int|None=None, error: str|None=None)` (dataclass); `parse_failures(results_path: Path) -> list[Failure]` — returns real failures only (flaky excluded); missing file → `[]`; malformed JSON or non-object top level → `ValueError`.

- [ ] **Step 1: Write the failing tests** (creates the test file with the shared import header)

```python
"""Unit tests for the canary-fail-fast skill scripts."""

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-fail-fast" / "scripts"
)
sys.path.insert(0, str(_SCRIPTS))

import parse  # noqa: E402


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
    failures = parse.parse_failures(_write(tmp_path, data))
    assert len(failures) == 1
    f = failures[0]
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
    failures = parse.parse_failures(_write(tmp_path, data))
    assert failures[0].error == "from-array"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'parse'` (or collection error).

- [ ] **Step 3: Write the implementation**

Create `scripts/__init__.py` empty, and `scripts/parse.py`:

```python
"""Minimal Playwright JSON parser — failing tests only (self-contained).

Walks the Playwright JSON reporter's nested suites/specs/tests and returns the
real failures. A failed/unexpected test with a passing retry is flaky and
excluded; without one it is a failure. Leading non-JSON banners are stripped
before parsing (matches the reporter's defensive indexOf('{')).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class Failure:
    title: str
    status: str
    file: Optional[str] = None
    line: Optional[int] = None
    error: Optional[str] = None


def parse_failures(results_path: Path) -> List[Failure]:
    if not results_path.exists():
        return []

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

    failures: List[Failure] = []
    for suite in data.get("suites", []) or []:
        _process_suite(suite, failures, parent_path="", suite_file="")
    return failures


def _process_suite(
    suite: Dict[str, Any],
    failures: List[Failure],
    parent_path: str,
    suite_file: str,
) -> None:
    suite_title = suite.get("title", "")
    suite_path = f"{parent_path} > {suite_title}" if parent_path else suite_title
    current_file = suite.get("file") or suite_file

    for child in suite.get("suites", []) or []:
        _process_suite(child, failures, suite_path, current_file)

    for spec in suite.get("specs", []) or []:
        spec_path = f"{suite_path} > {spec.get('title', '')}"
        spec_location = spec.get("location") or {}
        for test in spec.get("tests", []) or []:
            test_title = test.get("title") or spec.get("title", "")
            test_location = test.get("location") or {}
            results = test.get("results") or []

            status = test.get("status", "unknown")
            if status not in ("unexpected", "failed"):
                continue

            has_passing_retry = any(
                r.get("status") in ("passed", "expected") for r in results
            )
            if has_passing_retry:
                continue  # flaky — excluded from the failure count

            error: Optional[str] = None
            if results:
                last = results[-1]
                err = last.get("error") or {}
                error = err.get("message")
                if error is None:
                    errs = last.get("errors") or []
                    if errs:
                        error = errs[0].get("message")

            failures.append(
                Failure(
                    title=f"{spec_path} > {test_title}",
                    status=status,
                    file=test_location.get("file") or spec_location.get("file") or current_file,
                    line=test_location.get("line") or spec_location.get("line"),
                    error=error,
                )
            )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/scripts/__init__.py \
        agents/skills/claude-code/canary-fail-fast/scripts/parse.py \
        tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): minimal Playwright JSON failure parser"
```

---

### Task 2: `failures.py` — categorizer (verbatim port)

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/failures.py`
- Test: `tests/unit/test_canary_fail_fast.py` (append)

**Interfaces:**
- Produces: `FAILURE_CATEGORIES: tuple[str, ...]` = `("schema","auth","server","client","timeout","network","other")`; `categorize_failure(error: str|None) -> str` — first matching rule in declared order; `None`/no match → `"other"`.

- [ ] **Step 1: Write the failing tests** (append to the test file; add `import failures` after `import parse`)

```python
import failures  # noqa: E402  (add near the top, beside `import parse`)


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k categorize -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'failures'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/failures.py`:

```python
"""Heuristic failure categorization (self-contained, pure).

Order matters — the most distinctive signals are checked first so 4xx/5xx
status-code patterns don't swallow schema errors that happen to mention a
status code in a response preview.
"""

from __future__ import annotations

import re
from typing import Tuple

FAILURE_CATEGORIES: Tuple[str, ...] = (
    "schema",
    "auth",
    "server",
    "client",
    "timeout",
    "network",
    "other",
)

_RULES = [
    ("schema", re.compile(
        r'ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b',
        re.IGNORECASE,
    )),
    ("auth", re.compile(
        r"\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired",
        re.IGNORECASE,
    )),
    ("timeout", re.compile(
        r"timeout|timed out|etimedout|deadline exceeded",
        re.IGNORECASE,
    )),
    ("network", re.compile(
        r"econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed",
        re.IGNORECASE,
    )),
    ("server", re.compile(
        r"\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout",
        re.IGNORECASE,
    )),
    ("client", re.compile(
        r"\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict",
        re.IGNORECASE,
    )),
]


def categorize_failure(error: str | None) -> str:
    if not error:
        return "other"
    for category, pattern in _RULES:
        if pattern.search(error):
            return category
    return "other"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k categorize -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/scripts/failures.py tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): port failure categorizer (verbatim rules)"
```

---

### Task 3: `fastfail_check.py` — config audit (verbatim port)

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/fastfail_check.py`
- Test: `tests/unit/test_canary_fail_fast.py` (append)

**Interfaces:**
- Produces: `check_config(text: str) -> list[str]` — one recommendation per absent knob (`forbidOnly`/`maxFailures`/`retries`); empty list = all present. `CANONICAL: str` — paste-in block.

- [ ] **Step 1: Write the failing tests** (append; add `import fastfail_check`)

```python
import fastfail_check  # noqa: E402


def test_check_all_present_empty():
    text = "forbidOnly: true, maxFailures: 10, retries: 2"
    assert fastfail_check.check_config(text) == []


def test_check_missing_one_flags_it():
    text = "forbidOnly: true, maxFailures: 10"  # no retries
    recs = fastfail_check.check_config(text)
    assert len(recs) == 1 and "retries" in recs[0]


def test_check_missing_all_flags_three():
    assert len(fastfail_check.check_config("")) == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k check_ -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'fastfail_check'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/fastfail_check.py`:

```python
"""Fail-fast config audit for a Playwright config (pure, read-only).

Scans a `playwright.config.*` for the fail-fast knobs a suite should set so a
broken CI run aborts early instead of burning the whole matrix. Never edits the
config — it recommends, and `CANONICAL` is the block to paste in.
"""

from __future__ import annotations

CANONICAL = """\
export default defineConfig({
  // Fail fast in CI: abort once enough has clearly broken, never on local runs.
  forbidOnly: !!process.env.CI,             // a stray test.only fails the build
  maxFailures: process.env.CI ? 10 : 0,     // stop the run after 10 failures in CI
  retries: process.env.CI ? 2 : 0,          // absorb flakes in CI; surface them locally
  // ...your existing config
});
"""

# knob name -> why it matters
KNOBS = {
    "forbidOnly": "a stray `test.only` silently skips the rest of the suite",
    "maxFailures": "a broken run keeps burning the matrix instead of aborting early",
    "retries": "flakes either fail the build or hide locally without a CI retry policy",
}


def check_config(text: str) -> list[str]:
    """Return one recommendation per fail-fast knob missing from the config text.

    Empty list means all knobs are present. Substring scan — good enough to flag
    absence; it does not validate the knob's value.
    """
    return [
        f"Add `{knob}` — without it, {why}."
        for knob, why in KNOBS.items()
        if knob not in text
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k check_ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/scripts/fastfail_check.py tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): port fail-fast config audit"
```

---

### Task 4: `digest.py` — loud categorized digest

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/digest.py`
- Test: `tests/unit/test_canary_fail_fast.py` (append)

**Interfaces:**
- Consumes: `parse.Failure` (duck-typed: `.title`, `.error`, `.file`, `.line`); `failures.FAILURE_CATEGORIES`, `failures.categorize_failure`.
- Produces: `Digest(text: str, annotations: list[str], exit_code: int)`; `build_digest(failures: list) -> Digest` — empty → exit 0 + "✅ 0 failing tests."; non-empty → categorized text, one `::error` per failure, exit 1.

- [ ] **Step 1: Write the failing tests** (append; add `import digest`)

```python
import digest  # noqa: E402


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k digest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'digest'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/digest.py`:

```python
"""Loud, categorized failure digest (pure).

Turns a list of failures into a terse CI-log digest + `::error` workflow
annotations + a non-zero exit code, so an engineer triages from the run log
without opening the HTML report.
"""

from __future__ import annotations

from dataclasses import dataclass

from failures import FAILURE_CATEGORIES, categorize_failure


@dataclass
class Digest:
    text: str
    annotations: list
    exit_code: int


def _first_line(error, limit: int = 160) -> str:
    if not error:
        return "(no error message)"
    for line in error.splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return "(no error message)"


def build_digest(failures: list) -> Digest:
    if not failures:
        return Digest(text="✅ 0 failing tests.", annotations=[], exit_code=0)

    n = len(failures)
    by_cat: dict = {}
    for f in failures:
        by_cat.setdefault(categorize_failure(f.error), []).append(f)

    lines = [f"❌ {n} failing test{'s' if n != 1 else ''} — triage by category:", ""]
    for cat in FAILURE_CATEGORIES:
        bucket = by_cat.get(cat)
        if not bucket:
            continue
        lines.append(f"  {cat} ({len(bucket)}):")
        for f in bucket:
            lines.append(f"    - {f.title} — {_first_line(f.error)}")
    text = "\n".join(lines)

    annotations: list = []
    for f in failures:
        cat = categorize_failure(f.error)
        loc = ""
        if f.file:
            loc += f"file={f.file},"
        if f.line is not None:
            loc += f"line={f.line},"
        annotations.append(
            f"::error {loc}title=Test failure::{f.title} — {cat}: {_first_line(f.error)}"
        )

    return Digest(text=text, annotations=annotations, exit_code=1)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k digest -v`
Expected: PASS.

Note: the annotation is `::error <loc>title=…` where `<loc>` is empty when no file/line, so with no location the string is `::error title=Test failure::…` (matches `test_digest_annotation_omits_absent_location`).

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/scripts/digest.py tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): loud categorized digest + ::error annotations"
```

---

### Task 5: `cli.py` — orchestration + exit codes

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/scripts/cli.py`
- Test: `tests/unit/test_canary_fail_fast.py` (append)

**Interfaces:**
- Consumes: `fastfail_check.check_config`, `parse.parse_failures`, `digest.build_digest`.
- Produces: `main(argv: list[str]|None=None) -> int` — neither flag → 1; unreadable/malformed `--results` → 1 (clean stderr message, no traceback); digest exit code otherwise; config audit never raises the code.

- [ ] **Step 1: Write the failing tests** (append; add `import cli`)

```python
import cli  # noqa: E402


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k cli -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'cli'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/cli.py`:

```python
#!/usr/bin/env python3
"""canary-fail-fast — surface test failures fast and loud.

Bundled CLI for the canary-fail-fast skill. Two halves:

  --config <playwright.config.*>  audit fail-fast knobs (maxFailures/forbidOnly/
                                  retries); print recommendations (read-only).
  --results <playwright.json>     print a loud, categorized failure digest to the
                                  CI log + ::error annotations; exit non-zero on
                                  any failure so the step fails.

At least one of --config / --results is required. Self-contained — no external
skill dependency.

Invoked via `canary skills run canary-fail-fast -- --results <json> [--config <path>]`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make the sibling modules importable by bare name (parse/digest/fastfail_check),
# exactly as they import each other.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-fail-fast",
        description="Fail-fast config audit + loud run-end failure digest.",
    )
    parser.add_argument("--results", default=None, metavar="PATH", help="Playwright JSON results.")
    parser.add_argument("--config", default=None, metavar="PATH", help="Playwright config file.")
    args = parser.parse_args(argv)

    if not args.results and not args.config:
        print(
            "canary-fail-fast: nothing to do — pass --results and/or --config.",
            file=sys.stderr,
        )
        return 1

    # ---- config audit -----------------------------------------------------
    if args.config:
        from fastfail_check import check_config

        try:
            text = Path(args.config).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"canary-fail-fast: cannot read config: {exc}", file=sys.stderr)
            return 1
        recs = check_config(text)
        if recs:
            print("Fail-fast config recommendations:")
            for r in recs:
                print(f"  - {r}")
        else:
            print("Fail-fast config OK.")

    # ---- failure digest ---------------------------------------------------
    exit_code = 0
    if args.results:
        results_path = Path(args.results)
        if not results_path.exists():
            print(
                f"canary-fail-fast: results file not found: {results_path}",
                file=sys.stderr,
            )
            return 1

        from parse import parse_failures
        from digest import build_digest

        try:
            failures = parse_failures(results_path)
        except ValueError as exc:
            print(f"canary-fail-fast: {exc}", file=sys.stderr)
            return 1

        d = build_digest(failures)
        print(d.text)
        for ann in d.annotations:
            print(ann)
        exit_code = d.exit_code

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -v`
Expected: PASS (all tests across tasks 1–5).

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/scripts/cli.py tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): CLI wiring + exit-code contract"
```

---

### Task 6: `SKILL.md` + discovery/de-id verification

**Files:**
- Create: `agents/skills/claude-code/canary-fail-fast/SKILL.md`
- Test: `tests/unit/test_canary_fail_fast.py` (append)

**Interfaces:**
- Consumes: `agent.core.skill_registry.SkillRegistry`.
- Produces: a discoverable, runnable bundled skill named `canary-fail-fast`.

- [ ] **Step 1: Write the failing tests** (append)

```python
from agent.core.skill_registry import SkillRegistry  # noqa: E402

_SKILL_DIR = _SCRIPTS.parent


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-fail-fast" in skills
    assert skills["canary-fail-fast"].runnable


def test_skill_dir_has_no_client_strings():
    banned = ("capi" "llary", "cap" "well")  # split literals so this file doesn't leak the tokens
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} in {path}"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -k skill -v`
Expected: FAIL — `canary-fail-fast` not found (no `SKILL.md` yet).

- [ ] **Step 3: Write `SKILL.md`**

Create `agents/skills/claude-code/canary-fail-fast/SKILL.md`:

````markdown
---
name: canary-fail-fast
description:
  Surface test failures fast and loud — audit a Playwright config for fail-fast
  knobs (maxFailures/forbidOnly/retries) and print a loud, categorized failure
  digest to the CI log + ::error annotations at run end, failing the step so the
  signal can't be missed. Self-contained (bundles its own Playwright JSON parser
  and failure categorizer).
cli: scripts/cli.py
---

# Canary Fail-Fast

Make test failures **fast** (abort a broken run early) and **loud** (surface in
the CI log + Checks, not a file). Two halves:

1. **Fail-fast config audit** — flags the absence of `maxFailures`,
   `forbidOnly`, and `retries` in a `playwright.config.*`.
2. **Loud run-end digest** — a terse, categorized failure summary to stdout +
   `::error` annotations, with a non-zero exit.

Self-contained: it bundles a minimal Playwright JSON parser and the failure
categorizer, so it has no dependency on any other skill.

## Fail-fast config (paste into `playwright.config.ts`)

```ts
export default defineConfig({
  // Fail fast in CI: abort once enough has clearly broken, never on local runs.
  forbidOnly: !!process.env.CI, // a stray test.only fails the build
  maxFailures: process.env.CI ? 10 : 0, // stop the run after 10 failures in CI
  retries: process.env.CI ? 2 : 0, // absorb flakes in CI; surface them locally
  // ...your existing config
});
```

## Invocation

```bash
# Loud failure digest from a Playwright JSON run (exits non-zero on failures):
canary skills run canary-fail-fast -- --results test-results/results.json

# Audit the fail-fast config:
canary skills run canary-fail-fast -- --config playwright.config.ts

# Both at once:
canary skills run canary-fail-fast -- \
  --results test-results/results.json \
  --config playwright.config.ts
```

At least one of `--results` / `--config` is required. The digest exits `1` when
any test failed (so the CI step fails); the config audit alone never fails the
build.

## CI wiring (GitHub Actions)

Run after the Playwright step with `if: always()` so the digest surfaces even
when the test step already failed:

```yaml
- name: Run Playwright
  run: npx playwright test --reporter=json --output-file=test-results/results.json

- name: Fail-fast digest
  if: always()
  run: |
    canary skills run canary-fail-fast -- \
      --results test-results/results.json
```
````

- [ ] **Step 4: Run tests + markdownlint to verify green**

Run: `python -m pytest tests/unit/test_canary_fail_fast.py -v`
Expected: PASS (all tests).
Run: `npx markdownlint-cli2 agents/skills/claude-code/canary-fail-fast/SKILL.md` (or the repo's configured markdownlint command)
Expected: no errors.

Also confirm the CLI runs end to end:
Run: `python agents/skills/claude-code/canary-fail-fast/scripts/cli.py --config agents/skills/claude-code/canary-fail-fast/SKILL.md`
Expected: prints config recommendations (SKILL.md has the knob names, so likely "OK"); exit 0.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-fail-fast/SKILL.md tests/unit/test_canary_fail_fast.py
git commit -m "feat(canary-fail-fast): SKILL.md + discovery/de-id tests"
```

---

### Task 7: Full-suite verification + roadmap update

**Files:**
- Modify: `docs/roadmap.md` (mark "Fail-fast CI gate" done)

- [ ] **Step 1: Run the full test suite**

Run: `python -m pytest -q`
Expected: PASS (existing suite + the new fail-fast tests; ~730 tests).

- [ ] **Step 2: Grep the whole skill tree for residual client strings**

Run a case-insensitive grep of the skill dir for the overlay's client/company
identifiers (the tokens in the repo denylist) — expect no output.

- [ ] **Step 3: Mark the roadmap item done**

In `docs/roadmap.md`, under "Overlay Upstreaming" → "Fail-fast CI gate", change `**Status:** backlog` to `**Status:** done` and note the shipping skill path in the summary. Keep the line-per-field schema (single-line fields).

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): mark fail-fast CI gate done (canary-fail-fast shipped)"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/canary-fail-fast
gh pr create --title "feat(canary-fail-fast): bundled fail-fast CI gate (overlay upstreaming)" \
  --body "Generalizes the private overlay's fail-fast skill into a self-contained bundled skill. Config audit + loud categorized digest with ::error annotations. Self-contained parser/categorizer; no client strings. See docs/changes/canary-fail-fast/."
```

---

## Self-Review

**Spec coverage:**
- Config audit → Task 3. Loud digest + annotations + exit → Task 4. Parser (failures-only, flaky-excluded) → Task 1. Categorizer verbatim → Task 2. CLI flags + exit contract → Task 5. Bundled-skill home + `cli:` frontmatter + discovery → Task 6. De-id (names, client identifiers, no cross-skill dep) → enforced by the client-string test (Task 6) and the self-contained imports throughout. Full-suite + residual-string grep + roadmap → Task 7. All spec success criteria map to a task.
- Deviation from spec: the spec's separate `types.py` is folded into `parse.py` (a `types.py` on `sys.path` would shadow the stdlib `types` module). `digest.py` is duck-typed and needs no type import, so nothing else changes. This is a strict improvement and is called out in Global Constraints.

**Placeholder scan:** none — every code step contains complete, runnable code; every command has expected output.

**Type consistency:** `Failure` (parse.py) fields `title/status/file/line/error` are used consistently by the digest tests and `build_digest`. `parse_failures(Path) -> list[Failure]`, `categorize_failure(str|None) -> str`, `check_config(str) -> list[str]`, `build_digest(list) -> Digest`, `main(list|None) -> int` — signatures match across all consuming tasks. `FAILURE_CATEGORIES` name identical in `failures.py` and `digest.py`.
