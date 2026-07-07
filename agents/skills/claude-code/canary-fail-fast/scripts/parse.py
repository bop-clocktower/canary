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
