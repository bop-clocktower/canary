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
