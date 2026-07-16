"""Merge/correlate OTel span JSONL files into a Trace (pure, read-only).

Reads one or more `otel-spans.<worker>.jsonl` files (one JSON span object
per line, written by otel_bootstrap/instrument.mjs), groups spans by
`traceId`, resolves each trace's root span (the one carrying a `test.id`
attribute — set by otel_bootstrap/playwright-fixture.ts's root-span
fixture), and attaches that trace's HTTP child spans to the resolved test.
Traces with no `test.id`-attributed root bucket their HTTP spans under the
synthetic test id "__setup__" (traffic outside any test, e.g. global setup).

Assumed span envelope (see Task 2 note in the implementation plan for why
this shape is an assumption, not a pinned spec): {traceId, spanId,
parentSpanId, name, startTime, duration_ms, attributes{}} — matches exactly
what otel_bootstrap/instrument.mjs's JsonlFileSpanExporter writes; no
`endTime` key is emitted (duration_ms + startTime cover it). HTTP
attributes keyed http.method/http.request.method, http.url, http.route,
http.status_code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from run_types import RequestSpan, TestTrace, Trace

_SETUP_TEST_ID = "__setup__"


def read_traces(spans_dir: Path | str) -> Trace:
    spans_dir = Path(spans_dir)
    by_trace: Dict[str, List[Dict[str, Any]]] = {}

    if spans_dir.is_dir():
        for path in sorted(spans_dir.glob("otel-spans.*.jsonl")):
            for span in _read_jsonl(path):
                trace_id = span.get("traceId")
                if not trace_id:
                    continue
                by_trace.setdefault(trace_id, []).append(span)

    by_test: List[TestTrace] = []
    setup_requests: List[RequestSpan] = []
    spans_total = 0

    for trace_id, spans in by_trace.items():
        root = next((s for s in spans if _is_test_root(s)), None)
        http_spans = [s for s in spans if s is not root and _is_http_span(s)]
        requests = [_to_request_span(s) for s in http_spans]
        spans_total += len(requests)

        if root is None:
            setup_requests.extend(requests)
            continue

        attrs = root.get("attributes", {}) or {}
        by_test.append(TestTrace(
            test_id=attrs.get("test.id", ""),
            test_title=attrs.get("test.title", ""),
            test_file=attrs.get("test.file", ""),
            trace_id=trace_id,
            outcome=attrs.get("test.outcome", ""),
            requests=requests,
        ))

    if setup_requests:
        by_test.append(TestTrace(
            test_id=_SETUP_TEST_ID, test_title="", test_file="", trace_id="",
            outcome="", requests=setup_requests,
        ))

    return Trace(spans_total=spans_total, by_test=by_test)


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    spans: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            spans.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # malformed/torn line (e.g. a crashed worker's last write) — skip
    return spans


def _is_test_root(span: Dict[str, Any]) -> bool:
    return "test.id" in (span.get("attributes") or {})


def _is_http_span(span: Dict[str, Any]) -> bool:
    attrs = span.get("attributes") or {}
    return "http.method" in attrs or "http.request.method" in attrs


def _to_request_span(span: Dict[str, Any]) -> RequestSpan:
    attrs = span.get("attributes") or {}
    method = attrs.get("http.method") or attrs.get("http.request.method") or ""
    status: Optional[int] = attrs.get("http.status_code")
    return RequestSpan(
        method=method,
        url=attrs.get("http.url", ""),
        route=attrs.get("http.route"),
        status=status,
        duration_ms=span.get("duration_ms", 0.0),
        span_id=span.get("spanId", ""),
        started_at=span.get("startTime", ""),
    )
