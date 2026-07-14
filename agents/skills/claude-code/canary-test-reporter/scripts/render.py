"""Markdown renderer for Playwright test results (self-contained, pure)."""
from __future__ import annotations

from parse import ReportData, TestResult  # noqa: F401 (TestResult used for type hints)

_ERROR_LINE_LIMIT = 10


def _format_location(r: TestResult) -> str:
    if not r.file:
        return ""
    return f"`{r.file}:{r.line}`" if r.line else f"`{r.file}`"


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
    status_line = f"{data.total} tests · {duration_s:.1f}s\n"
    if chips:
        status_line = " · ".join(chips) + " · " + status_line
    parts.append(status_line)

    # Failed section
    failed = [r for r in data.results if r.status == "failed"]
    if failed:
        parts.append(f"\n## Failed ({len(failed)})\n")
        for r in failed:
            parts.append(f"\n### {r.title}\n")
            loc = _format_location(r)
            if loc:
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
            loc = _format_location(r)
            parts.append(f"\n- {loc + ' — ' if loc else ''}{r.title}\n")

    # Summary table
    parts.append("\n## Summary\n")
    parts.append("\n| Status | Count |\n| --- | --- |\n")
    parts.append(f"| Passed | {data.passed} |\n")
    parts.append(f"| Failed | {data.failed} |\n")
    parts.append(f"| Flaky | {data.flaky} |\n")
    parts.append(f"| Skipped | {data.skipped} |\n")
    parts.append(f"| **Total** | **{data.total}** |\n")

    return "".join(parts)
