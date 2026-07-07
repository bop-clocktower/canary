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
