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
