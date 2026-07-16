# Canary Instrument Implementation Plan

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: long command/prose lines and
     label-then-list blocks (**Files:** followed by a list) are used
     throughout, matching the canary-fail-fast plan's relaxed MD013/MD032. -->

> **For agentic workers:** Use harness-execution (or an equivalent
> task-by-task executor) to implement this plan. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Ship `canary-instrument`, a self-contained bundled executable
skill that instruments a Playwright run with OpenTelemetry and emits a
`run.json` artifact correlating each test to the outbound HTTP requests it
made, using OTel span parent/child relationships — no manual bookkeeping in
test code.

**Architecture:** A skill directory at
`agents/skills/claude-code/canary-instrument/` with a `scripts/` package of
three small Python modules (`run_types.py`, `span_reader.py`, `cli.py`) plus
a Node/TS `otel_bootstrap/` pair the consumer wires into their own suite
(`instrument.mjs`, `playwright-fixture.ts`). No dependency on any other
skill or `agent/` module (matches `canary-fail-fast` / `canary-test-reporter`
precedent). Trace-only v1 (`coverage` block and `canary_run_id` cut per
spec YAGNI).

**Tech Stack:** Python 3.13/3.14 (`argparse`, `dataclasses`, `glob`/`Path`,
pytest) for `scripts/*.py`; Node.js >= 18 ESM + TypeScript for
`otel_bootstrap/*` (fixture files, not independently unit-tested — see
Task 5). Discovered/run by the existing `SkillRegistry` (`cli:` frontmatter
and `canary skills run`).

**Spec:** `docs/changes/canary-instrument/proposal.md`
**Skill recommendations:** `docs/changes/canary-instrument/SKILLS.md`
(reference tier only: `test-playwright-setup`, `test-playwright-patterns` —
informs Task 5's Playwright fixture code)
**Integration Tier:** medium (new bundled skill, new exports, ~9 files,
no new public CLI surface beyond `canary skills run`)

## Observable Truths (traced to spec Success Criteria 1–13)

1. `canary skills run canary-instrument -- --spans <dir> --output <dir>`
   writes a `run.json` matching the v1 contract exactly — Task 4.
2. `span_reader.read_traces()` correlates a synthetic multi-worker span
   fixture correctly (root resolution, `__setup__` bucket) — Task 2, Task 3.
3. `spans_total` reconciles against `by_test[].requests` + `__setup__` —
   Task 2, Task 3.
4. Multiple `otel-spans.<worker>.jsonl` files merge without collision —
   Task 3.
5. Missing/empty `--spans` directory → valid empty `run.json`, not a
   failure — Task 2, Task 4.
6. `--suite-type` is an arbitrary string, passed through verbatim — Task 4.
7. No `OTEL_EXPORTER_OTLP_ENDPOINT` set → file exporter only, no network —
   Task 5 (documented behavior; not independently pytest-testable).
8. Malformed/torn JSONL lines are skipped, not raised — Task 3.
9. `--output` directory is created if missing — Task 4.
10. De-id test: zero residual company-specific strings in the shipped
    skill dir (incl. `.mjs`/`.ts`, not just `.py`/`.md`) — Task 6.
11. `SKILL.md` documents both manual wiring steps clearly enough to set up
    from the doc alone — Task 7.
12. `harness validate` passes; `scripts/check_removed_symbols.py`
    (docs-lint) passes — Task 10.
13. Dedicated test suite covers `run_types.py` + `span_reader.py` with
    meaningful assertions — Tasks 1–3.

## Uncertainties

- **[ASSUMPTION]** Exact OTel JSON span envelope shape (`traceId`,
  `spanId`, `parentSpanId`, `name`, `startTime`, `endTime`, `duration_ms`,
  `attributes{}`) and the HTTP semconv attribute keys used
  (`http.method`/`http.url`/`http.route`/`http.status_code`) are not
  pinned by the spec (it shows only the output `run.json` shape, not the
  input span shape). This plan assumes the shape the private overlay's
  `instrument.mjs` most plausibly emits (standard OTel JS auto-instrumentation
  semconv, matching the fields the `run.json` contract needs). If the
  execution phase discovers the real span shape differs, `span_reader.py`'s
  field-extraction helpers (`_to_request_span`, `_is_http_span`,
  `_is_test_root`) are the only code that needs adjusting — the module's
  public contract (`read_traces(dir) -> Trace`) does not change. Flag this
  explicitly if adjusted.
- **[ASSUMPTION]** `cli.py`'s only hard-failure path is `--spans` pointing
  at a non-directory path that exists (e.g. a file). A missing `--spans`
  directory is success (spec criterion 5), so there is little else to fail
  on. If a real span-parsing failure needs a distinct exit code, add it in
  Task 4 — cheap to extend, not blocking.
- **[ASSUMPTION]** ADR path follows this repo's real, established
  convention — `docs/adr/NNNN-title.md` with an index in
  `docs/adr/README.md` (5 prior ADRs, see `docs/adr/0001`–`0005`) — rather
  than the spec's literal `docs/specs/adr-otel-test-side-tracing.md`. The
  spec's path does not match any existing ADR in the repo; `docs/specs/`
  holds design specs, not ADRs. Task 8 uses `docs/adr/0006-...md` and
  updates the index. Flagged for human review at plan sign-off — trivial to
  revert to the spec's literal path if that was intentional.
- **[DEFERRABLE]** `docs/knowledge/` note on the `run.json`
  `by_test[]` ↔ `canary-test-reporter`'s `TestResult` shape similarity
  (future TCM pattern) — spec explicitly defers this (YAGNI), not in this
  plan.
- **[DEFERRABLE]** `docs/roadmap.md` "OTel instrumentation bootstrap" status
  bump to `done` — spec explicitly says "not here" (ship-time task, outside
  this plan), unlike the `canary-fail-fast` precedent which did include a
  roadmap-done task. Not in this plan's task list.

## File Map

```text
CREATE agents/skills/claude-code/canary-instrument/scripts/__init__.py
CREATE agents/skills/claude-code/canary-instrument/scripts/run_types.py
CREATE agents/skills/claude-code/canary-instrument/scripts/span_reader.py
CREATE agents/skills/claude-code/canary-instrument/scripts/cli.py
CREATE agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs
CREATE agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/playwright-fixture.ts
CREATE agents/skills/claude-code/canary-instrument/SKILL.md
CREATE tests/unit/test_canary_instrument.py
CREATE docs/adr/0006-otel-test-side-tracing.md
MODIFY docs/adr/README.md (add index row)
MODIFY docs/guides/company-knowledge.md (add usage example cross-reference)
```

**Test import convention** (matches `canary-fail-fast` /
`canary-test-reporter`): `tests/unit/test_canary_instrument.py` inserts the
skill's `scripts/` dir at `sys.path[0]` and imports modules by bare name
(`run_types`, `span_reader`, `cli`) — the same resolution `cli.py` uses at
runtime. Because the module name `cli` is already used by
`canary-fail-fast` and `canary-test-reporter`'s own `scripts/cli.py`, the
test file must pop any cached `run_types`/`span_reader`/`cli` modules from
`sys.modules` before importing (see `test_canary_test_reporter.py`'s
`_isolate_namespace` autouse fixture) — otherwise a full-suite `pytest -q`
run can import the wrong skill's `cli` module depending on collection
order.

## Global Constraints

- **Self-contained:** no imports outside the skill's own `scripts/` dir.
- **No client strings:** company/product identifiers
  (case-insensitive) must not appear anywhere in the shipped skill dir,
  including `.mjs`/`.ts` files (the repo-wide `check_removed_symbols.py`
  guard only scans `.md/.py/.json/.svg/.html/.yml/.yaml/.txt/.toml` —
  it does **not** cover `.mjs`/`.ts`, so the skill's own de-id test in
  Task 6 is the only guard for the bootstrap files).
- **No `coverage` key, no `canary_run_id` key** in `run.json`, ever —
  enforced by an explicit test in Task 1.
- **`suite_type`:** free-form string, no enum validation, passed through
  verbatim.
- **Module naming:** no module named `types.py` (shadows stdlib) — the
  skill's dataclasses module is `run_types.py` (also avoids colliding with
  a hypothetical future `types.py` in another bundled skill).
- **Docs:** `SKILL.md` and the ADR must pass markdownlint (repo pre-commit
  hook enforces `.markdownlint.json`: MD013 line_length 80 (code
  blocks/tables exempt), MD022, MD031, MD032).

---

### Task 1: `run_types.py` — `RequestSpan`/`TestTrace`/`Trace`/`RunArtifact`

**Depends on:** none | **Files:**
`agents/skills/claude-code/canary-instrument/scripts/__init__.py`,
`agents/skills/claude-code/canary-instrument/scripts/run_types.py`,
`tests/unit/test_canary_instrument.py`

**Interfaces:**
- Produces: `RequestSpan(method, url, route, status, duration_ms, span_id, started_at)`,
  `TestTrace(test_id, test_title, test_file, trace_id, outcome, requests: list[RequestSpan])`,
  `Trace(spans_total: int, by_test: list[TestTrace])`,
  `RunArtifact(schema_version: int, suite_type: str, generated_at: str, trace: Trace)`
  — all `@dataclass`. `RunArtifact.to_dict() -> dict` is a plain
  `dataclasses.asdict()` call.

- [ ] **Step 1: Write the failing tests** (creates the test file with the
  shared import header)

```python
"""Unit tests for the canary-instrument skill scripts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "agents" / "skills" / "claude-code" / "canary-instrument" / "scripts"
)
_SKILL_DIR = _SCRIPTS.parent

# Clear cached modules from other skills' test files to avoid namespace
# collision in a full-suite pytest run (canary-fail-fast and
# canary-test-reporter each ship their own `cli` module).
for _mod in ["run_types", "span_reader", "cli"]:
    sys.modules.pop(_mod, None)

if str(_SCRIPTS) in sys.path:
    sys.path.remove(str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS))

import run_types  # noqa: E402


def test_run_artifact_to_dict_has_no_coverage_or_run_id_keys():
    artifact = run_types.RunArtifact(
        schema_version=1,
        suite_type="e2e_ui",
        generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=0, by_test=[]),
    )
    d = artifact.to_dict()
    assert "coverage" not in d
    assert "canary_run_id" not in d
    assert d["schema_version"] == 1
    assert d["suite_type"] == "e2e_ui"


def test_run_artifact_to_dict_serializes_nested_requests():
    req = run_types.RequestSpan(
        method="GET", url="http://localhost:3000/users/1", route="/users/:id",
        status=200, duration_ms=12.4, span_id="def456", started_at="2026-07-15T18:00:01+00:00",
    )
    tt = run_types.TestTrace(
        test_id="users-spec:1", test_title="lists users", test_file="tests/users.spec.ts",
        trace_id="abc123", outcome="passed", requests=[req],
    )
    artifact = run_types.RunArtifact(
        schema_version=1, suite_type="", generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=1, by_test=[tt]),
    )
    d = artifact.to_dict()
    assert d["trace"]["spans_total"] == 1
    row = d["trace"]["by_test"][0]
    assert row["test_id"] == "users-spec:1" and row["outcome"] == "passed"
    assert row["requests"][0]["method"] == "GET"
    assert row["requests"][0]["status"] == 200


def test_run_artifact_to_dict_is_json_serializable():
    artifact = run_types.RunArtifact(
        schema_version=1, suite_type="api", generated_at="2026-07-15T18:00:00+00:00",
        trace=run_types.Trace(spans_total=0, by_test=[]),
    )
    # Round-trips cleanly — this is exactly what cli.py writes to disk.
    text = json.dumps(artifact.to_dict())
    assert json.loads(text)["suite_type"] == "api"


def test_test_trace_requests_defaults_to_empty_list():
    tt = run_types.TestTrace(
        test_id="__setup__", test_title="", test_file="", trace_id="", outcome="",
    )
    assert tt.requests == []


def test_trace_by_test_defaults_to_empty_list():
    assert run_types.Trace(spans_total=0).by_test == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'run_types'` (or
collection error).

- [ ] **Step 3: Write the implementation**

Create `scripts/__init__.py` (empty), and `scripts/run_types.py`:

```python
"""Dataclasses for the run.json v1 contract (trace-only).

RunArtifact.to_dict() is a plain dataclasses.asdict() call — the JSON shape
on disk is the dataclass shape, field-for-field. No `coverage` key and no
`canary_run_id` key exist anywhere in this module: both were cut for v1
(see docs/changes/canary-instrument/proposal.md — coverage is a separate
future skill; canary_run_id has no consumer yet). Additive-only evolution:
new optional fields may be appended later; existing fields never change
meaning.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class RequestSpan:
    method: str
    url: str
    route: Optional[str]
    status: Optional[int]
    duration_ms: float
    span_id: str
    started_at: str


@dataclass
class TestTrace:
    test_id: str  # "__setup__" for orphan (rootless) traffic
    test_title: str
    test_file: str
    trace_id: str
    outcome: str
    requests: List[RequestSpan] = field(default_factory=list)


@dataclass
class Trace:
    spans_total: int
    by_test: List[TestTrace] = field(default_factory=list)


@dataclass
class RunArtifact:
    schema_version: int
    suite_type: str
    generated_at: str
    trace: Trace

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add agents/skills/claude-code/canary-instrument/scripts/__init__.py \
        agents/skills/claude-code/canary-instrument/scripts/run_types.py \
        tests/unit/test_canary_instrument.py
git commit -m "feat(canary-instrument): run.json v1 contract dataclasses"
```

---

### Task 2: `span_reader.py` — single-trace correlation (root resolution, `__setup__` bucket)

**Depends on:** Task 1 | **Files:**
`agents/skills/claude-code/canary-instrument/scripts/span_reader.py`,
`tests/unit/test_canary_instrument.py` (append)

**Interfaces:**
- Consumes: `run_types.RequestSpan`, `run_types.TestTrace`, `run_types.Trace`.
- Produces: `read_traces(spans_dir: Path | str) -> Trace` — globs
  `otel-spans.*.jsonl` in `spans_dir`, groups spans by `traceId`, resolves
  each trace's root via presence of a `test.id` attribute, attaches that
  trace's HTTP child spans (spans carrying `http.method`/`http.request.method`)
  to the resolved `TestTrace`, and buckets HTTP spans from rootless traces
  under the synthetic id `"__setup__"`. Missing/nonexistent `spans_dir` or
  an existing-but-empty dir both return `Trace(spans_total=0, by_test=[])`.

- [ ] **Step 1: Write the failing tests** (append to the test file; add
  `import span_reader` after `import run_types`)

```python
import span_reader  # noqa: E402


def _span(trace_id, span_id, *, attrs=None, duration_ms=1.0):
    return {
        "traceId": trace_id,
        "spanId": span_id,
        "parentSpanId": None,
        "name": "span",
        "startTime": "2026-07-15T18:00:01+00:00",
        "endTime": "2026-07-15T18:00:01+00:00",
        "duration_ms": duration_ms,
        "attributes": attrs or {},
    }


def _root_span(trace_id, span_id, *, test_id, title, file, outcome="passed"):
    return _span(trace_id, span_id, attrs={
        "test.id": test_id, "test.title": title, "test.file": file, "test.outcome": outcome,
    })


def _http_span(trace_id, span_id, *, method="GET", url="http://x/1", route="/x/:id",
                status=200, duration_ms=12.4):
    return _span(trace_id, span_id, attrs={
        "http.method": method, "http.url": url, "http.route": route,
        "http.status_code": status,
    }, duration_ms=duration_ms)


def _write_jsonl(path, spans):
    path.write_text("\n".join(json.dumps(s) for s in spans) + "\n", encoding="utf-8")


def test_missing_spans_dir_returns_empty_trace(tmp_path):
    trace = span_reader.read_traces(tmp_path / "does-not-exist")
    assert trace.spans_total == 0 and trace.by_test == []


def test_empty_spans_dir_returns_empty_trace(tmp_path):
    trace = span_reader.read_traces(tmp_path)  # exists, no *.jsonl files
    assert trace.spans_total == 0 and trace.by_test == []


def test_http_child_attaches_to_test_root(tmp_path):
    spans = [
        _root_span("t1", "s1", test_id="users-spec:1", title="lists users", file="tests/users.spec.ts"),
        _http_span("t1", "s2"),
    ]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1
    assert len(trace.by_test) == 1
    tt = trace.by_test[0]
    assert tt.test_id == "users-spec:1" and tt.outcome == "passed"
    assert len(tt.requests) == 1
    assert tt.requests[0].method == "GET" and tt.requests[0].status == 200


def test_rootless_trace_buckets_under_setup(tmp_path):
    spans = [_http_span("t2", "s1", url="http://x/health")]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1
    assert len(trace.by_test) == 1
    assert trace.by_test[0].test_id == "__setup__"
    assert trace.by_test[0].requests[0].url == "http://x/health"


def test_root_span_itself_is_not_counted_as_a_request(tmp_path):
    spans = [_root_span("t1", "s1", test_id="a:1", title="a", file="a.spec.ts")]
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", spans)
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 0
    assert trace.by_test[0].requests == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_instrument.py -k "span_reader or spans_dir or attaches_to or buckets_under or not_counted" -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'span_reader'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/span_reader.py`:

```python
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
parentSpanId, name, startTime, endTime, duration_ms, attributes{}}, HTTP
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: PASS (11 tests: 5 from Task 1 + 6 from Task 2).

- [ ] **Step 5: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add agents/skills/claude-code/canary-instrument/scripts/span_reader.py \
        tests/unit/test_canary_instrument.py
git commit -m "feat(canary-instrument): single-trace span correlation + __setup__ bucket"
```

---

### Task 3: `span_reader.py` — multi-worker merge + malformed-line skip

**Depends on:** Task 2 | **Files:**
`agents/skills/claude-code/canary-instrument/scripts/span_reader.py`
(no new functions — this task extends test coverage of the existing
`read_traces`/`_read_jsonl` against multi-file and torn-line inputs),
`tests/unit/test_canary_instrument.py` (append)

**Interfaces:** No new public interface — `read_traces` from Task 2 already
handles multiple files (it globs `otel-spans.*.jsonl`) and malformed lines
(`_read_jsonl` already skips `JSONDecodeError`). This task adds the tests
that prove those two behaviors explicitly, per spec success criteria 4 and
8 — if either test fails, the Task 2 implementation needs a fix, not a
rewrite.

- [ ] **Step 1: Write the failing tests** (append to the test file)

```python
def test_multi_worker_files_merge_without_collision(tmp_path):
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2", url="http://x/a"),
    ])
    _write_jsonl(tmp_path / "otel-spans.1.jsonl", [
        _root_span("t2", "s1", test_id="b:1", title="test b", file="b.spec.ts"),
        _http_span("t2", "s2", url="http://x/b"),
    ])
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 2
    assert {tt.test_id for tt in trace.by_test} == {"a:1", "b:1"}
    # spanId "s1"/"s2" repeat across workers but traceId differs — no collision.
    urls = {req.url for tt in trace.by_test for req in tt.requests}
    assert urls == {"http://x/a", "http://x/b"}


def test_reconciliation_holds_across_setup_and_test_buckets(tmp_path):
    _write_jsonl(tmp_path / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
        _http_span("t1", "s3"),
        _http_span("t3", "s1"),  # rootless -> __setup__
    ])
    trace = span_reader.read_traces(tmp_path)
    total_requests = sum(len(tt.requests) for tt in trace.by_test)
    assert trace.spans_total == total_requests == 3
    setup = next(tt for tt in trace.by_test if tt.test_id == "__setup__")
    assert len(setup.requests) == 1


def test_malformed_torn_line_is_skipped_not_raised(tmp_path):
    good = [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
    ]
    path = tmp_path / "otel-spans.0.jsonl"
    text = "\n".join(json.dumps(s) for s in good) + "\n"
    text += '{"traceId": "t1", "spanId": "s3", "attributes": {"http.method"'  # torn, no error raised
    path.write_text(text, encoding="utf-8")

    trace = span_reader.read_traces(tmp_path)  # must not raise
    assert trace.spans_total == 1
    assert trace.by_test[0].test_id == "a:1"


def test_blank_lines_between_spans_are_ignored(tmp_path):
    path = tmp_path / "otel-spans.0.jsonl"
    spans = [_root_span("t1", "s1", test_id="a:1", title="a", file="a.spec.ts"), _http_span("t1", "s2")]
    path.write_text("\n\n".join(json.dumps(s) for s in spans) + "\n\n", encoding="utf-8")
    trace = span_reader.read_traces(tmp_path)
    assert trace.spans_total == 1
```

- [ ] **Step 2: Run tests to verify they fail (or pass immediately if Task 2's implementation already covers this — confirm, don't assume)**

Run: `python -m pytest tests/unit/test_canary_instrument.py -k "multi_worker or reconciliation or malformed or blank_lines" -v`
Expected: PASS immediately if Task 2's `read_traces`/`_read_jsonl` is
correct (this task adds coverage, not new code). If any test fails, fix
`span_reader.py` from Task 2 until green — do not add new public functions.

- [ ] **Step 3: (only if Step 2 failed) Fix `span_reader.py`**

Diagnose against the failing assertion; the most likely gap is
`_read_jsonl` not stripping a trailing incomplete line correctly, or
`spans_dir.glob` not sorting workers deterministically. Re-run Step 2 after
any fix.

- [ ] **Step 4: Run the full module's tests to verify green**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: PASS (15 tests: 5 + 6 + 4).

- [ ] **Step 5: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add tests/unit/test_canary_instrument.py \
        agents/skills/claude-code/canary-instrument/scripts/span_reader.py
git commit -m "test(canary-instrument): multi-worker merge + malformed-line coverage"
```

---

### Task 4: `cli.py` — argument surface, `run.json` output, exit codes

**Depends on:** Task 1, Task 2, Task 3 | **Files:**
`agents/skills/claude-code/canary-instrument/scripts/cli.py`,
`tests/unit/test_canary_instrument.py` (append)

**Interfaces:**
- Consumes: `run_types.RunArtifact`, `span_reader.read_traces`.
- Produces: `main(argv: list[str] | None = None) -> int`. Flags: `--spans
  DIR` (required), `--output DIR` (required), `--suite-type STR` (optional,
  default `""`). Writes `<output>/run.json`. Creates `--output` if missing.
  `--spans` pointing at an existing non-directory path → stderr message,
  exit 1. Otherwise exit 0 (including when `--spans` doesn't exist —
  produces an empty trace, not a failure, per spec criterion 5).

- [ ] **Step 1: Write the failing tests** (append; add `import cli`)

```python
import cli  # noqa: E402


def test_cli_writes_run_json_with_correct_shape(tmp_path, capsys):
    spans_dir = tmp_path / "spans"
    spans_dir.mkdir()
    _write_jsonl(spans_dir / "otel-spans.0.jsonl", [
        _root_span("t1", "s1", test_id="a:1", title="test a", file="a.spec.ts"),
        _http_span("t1", "s2"),
    ])
    out_dir = tmp_path / "out"
    rc = cli.main(["--spans", str(spans_dir), "--output", str(out_dir), "--suite-type", "e2e_ui"])
    assert rc == 0
    run_json = json.loads((out_dir / "run.json").read_text(encoding="utf-8"))
    assert run_json["schema_version"] == 1
    assert run_json["suite_type"] == "e2e_ui"
    assert "coverage" not in run_json and "canary_run_id" not in run_json
    assert run_json["trace"]["spans_total"] == 1


def test_cli_creates_missing_output_dir(tmp_path):
    out_dir = tmp_path / "nested" / "out"
    assert not out_dir.exists()
    rc = cli.main(["--spans", str(tmp_path / "no-spans"), "--output", str(out_dir)])
    assert rc == 0
    assert (out_dir / "run.json").exists()


def test_cli_missing_spans_dir_is_not_a_failure(tmp_path):
    rc = cli.main(["--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out")])
    assert rc == 0
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["trace"] == {"spans_total": 0, "by_test": []}


def test_cli_suite_type_defaults_to_empty_string(tmp_path):
    cli.main(["--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out")])
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["suite_type"] == ""


def test_cli_suite_type_accepts_arbitrary_string_no_enum(tmp_path):
    rc = cli.main([
        "--spans", str(tmp_path / "nope"), "--output", str(tmp_path / "out"),
        "--suite-type", "totally-made-up-value",
    ])
    assert rc == 0
    run_json = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert run_json["suite_type"] == "totally-made-up-value"


def test_cli_spans_path_is_a_file_not_dir_fails(tmp_path, capsys):
    bad_spans = tmp_path / "spans-is-a-file"
    bad_spans.write_text("oops", encoding="utf-8")
    rc = cli.main(["--spans", str(bad_spans), "--output", str(tmp_path / "out")])
    assert rc == 1
    assert "not a directory" in capsys.readouterr().err


def test_cli_missing_required_flags_errors(capsys):
    with pytest.raises(SystemExit):
        cli.main([])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/unit/test_canary_instrument.py -k cli -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'cli'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/cli.py`:

```python
#!/usr/bin/env python3
"""canary-instrument — correlate a Playwright run's tests to their outbound HTTP spans.

Reads OTel span JSONL files written by otel_bootstrap/instrument.mjs (see
SKILL.md for the two manual wiring steps), resolves each Playwright test's
root span (set by otel_bootstrap/playwright-fixture.ts), attaches HTTP
child spans, and writes a run.json v1 artifact (trace-only; see
run_types.RunArtifact for the contract).

Invoked via:
  canary skills run canary-instrument -- \\
    --spans test-results/trace --output test-results [--suite-type e2e_ui]

Missing/empty --spans is not a failure — it produces an empty trace block.
Self-contained — no external skill dependency.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Make the sibling modules importable by bare name (run_types/span_reader),
# exactly as they import each other.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-instrument",
        description="Correlate a Playwright run's tests to their outbound HTTP spans.",
    )
    parser.add_argument("--spans", required=True, metavar="DIR",
                        help="Directory containing otel-spans.<worker>.jsonl files.")
    parser.add_argument("--output", required=True, metavar="DIR",
                        help="Directory to write run.json into (created if missing).")
    parser.add_argument("--suite-type", default="", metavar="STR",
                        help="Free-form suite label, passed through verbatim.")
    args = parser.parse_args(argv)

    spans_dir = Path(args.spans)
    if spans_dir.exists() and not spans_dir.is_dir():
        print(f"canary-instrument: --spans is not a directory: {spans_dir}", file=sys.stderr)
        return 1

    from run_types import RunArtifact
    from span_reader import read_traces

    trace = read_traces(spans_dir)
    artifact = RunArtifact(
        schema_version=1,
        suite_type=args.suite_type,
        generated_at=datetime.now(timezone.utc).isoformat(),
        trace=trace,
    )

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "run.json"
    out_path.write_text(json.dumps(artifact.to_dict(), indent=2), encoding="utf-8")

    print(
        f"canary-instrument: wrote {out_path} "
        f"({trace.spans_total} spans, {len(trace.by_test)} test buckets)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: PASS (22 tests: 15 from Tasks 1–3 + 7 from Task 4).

- [ ] **Step 5: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add agents/skills/claude-code/canary-instrument/scripts/cli.py \
        tests/unit/test_canary_instrument.py
git commit -m "feat(canary-instrument): CLI wiring + run.json output + exit contract"
```

---

### Task 5: `otel_bootstrap/instrument.mjs` + `playwright-fixture.ts` — port, rename, de-identify

**Skills:** `test-playwright-setup` (reference), `test-playwright-patterns`
(reference) — Playwright fixture-composition conventions for
`playwright-fixture.ts`.

**Depends on:** none (independent of the Python modules — no code import
relationship; sequenced here to match the spec's Implementation Order)
| **Files:**
`agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs`,
`agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/playwright-fixture.ts`

**Interfaces:** No Python interface — these are runtime fixture files the
*consumer* imports into their own suite (not independently pytest-testable;
spec success criterion 13 explicitly excludes them from the Python test
suite). `instrument.mjs` is loaded via `NODE_OPTIONS="--import
.../instrument.mjs"`; `playwright-fixture.ts` exports
`withTestSpan(base: Test): Test` for merging into the consumer's
`fixtures.ts`.

- [ ] **Step 1: Write `otel_bootstrap/instrument.mjs`**

```js
// otel_bootstrap/instrument.mjs
//
// Node OTel SDK bootstrap for canary-instrument. Import via:
//   NODE_OPTIONS="--import ./otel_bootstrap/instrument.mjs" npx playwright test
//
// Default: writes one JSON span per line to
//   test-results/trace/otel-spans.<TEST_WORKER_INDEX>.jsonl
// (no collector required — this is what scripts/span_reader.py reads).
// When OTEL_EXPORTER_OTLP_ENDPOINT is set, spans are *additionally*
// streamed to that collector via OTLPTraceExporter; the file path above is
// unaffected either way.
//
// Auto-instruments HTTP/undici only — fs instrumentation is disabled so
// Playwright's own file I/O doesn't show up as noise spans.
//
// Consumer-supplied dependencies (not vendored by this skill):
//   @opentelemetry/sdk-node @opentelemetry/api
//   @opentelemetry/auto-instrumentations-node
//   @opentelemetry/exporter-trace-otlp-http

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import fs from 'node:fs';
import path from 'node:path';

const workerIndex = process.env.TEST_WORKER_INDEX ?? '0';
const outDir = path.join(process.cwd(), 'test-results', 'trace');
fs.mkdirSync(outDir, { recursive: true });
const outStream = fs.createWriteStream(
  path.join(outDir, `otel-spans.${workerIndex}.jsonl`),
  { flags: 'a' },
);

/** Minimal file exporter — one JSON span per line, matches span_reader.py. */
class JsonlFileSpanExporter {
  export(spans, resultCallback) {
    for (const span of spans) {
      const [startSec, startNs] = span.startTime;
      const [durSec, durNs] = span.duration;
      outStream.write(JSON.stringify({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: new Date(startSec * 1000 + startNs / 1e6).toISOString(),
        duration_ms: durSec * 1000 + durNs / 1e6,
        attributes: span.attributes,
      }) + '\n');
    }
    resultCallback({ code: 0 });
  }

  shutdown() {
    return new Promise((resolve) => outStream.end(resolve));
  }
}

const spanProcessors = [new SimpleSpanProcessor(new JsonlFileSpanExporter())];

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  spanProcessors.push(
    new SimpleSpanProcessor(
      new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    ),
  );
}

const sdk = new NodeSDK({
  spanProcessors,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
process.on('exit', () => sdk.shutdown());
```

- [ ] **Step 2: Write `otel_bootstrap/playwright-fixture.ts`**

```ts
// otel_bootstrap/playwright-fixture.ts
//
// withTestSpan(base) wraps a Playwright `test` object with an `auto`
// fixture that opens one root span per test (test.id/test.title/test.file
// attributes), activates it as the OTel active context so the test's HTTP
// calls nest as child spans (the whole correlation trick this skill relies
// on), and closes it in teardown with test.outcome set from
// testInfo.status. Merge into your own fixtures.ts:
//
//   import { test as base } from '@playwright/test';
//   import { withTestSpan } from './otel_bootstrap/playwright-fixture';
//   export const test = withTestSpan(base);
//
// Root-span-via-fixture (not a custom reporter) is deliberate — reporters
// run in Playwright's main process and can't establish the OTel active
// context the HTTP auto-instrumentation needs to nest child spans. See
// docs/adr/0006-otel-test-side-tracing.md.

import type { TestType } from '@playwright/test';
import { trace, context } from '@opentelemetry/api';

const tracer = trace.getTracer('canary-instrument');

export function withTestSpan<T extends TestType<any, any>>(base: T): T {
  return base.extend({
    _rootSpan: [
      async ({}, use, testInfo) => {
        const span = tracer.startSpan(testInfo.title, {
          attributes: {
            'test.id': testInfo.titlePath.join(':'),
            'test.title': testInfo.title,
            'test.file': testInfo.file,
          },
        });
        await context.with(trace.setSpan(context.active(), span), async () => {
          await use();
        });
        span.setAttribute('test.outcome', testInfo.status ?? 'unknown');
        span.end();
      },
      { auto: true },
    ] as any,
  }) as T;
}
```

- [ ] **Step 3: Syntax-check both files (no OTel deps installed in this repo — structural check only)**

Run: `node --check agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs`
Expected: no output (valid ESM syntax). `.ts` has no equivalent
dependency-free check in this repo (the consumer supplies `@opentelemetry/api`
and `@playwright/test` types); review the file by eye against the
`withTestSpan` contract described in `SKILL.md` (Task 7) instead of running
a type-checker here.

- [ ] **Step 4: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs \
        agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/playwright-fixture.ts
git commit -m "feat(canary-instrument): OTel bootstrap + root-span Playwright fixture"
```

---

### Task 6: De-id test — grep the shipped skill directory for residual client strings

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5 | **Files:**
`tests/unit/test_canary_instrument.py` (append)

**Interfaces:** No production code — test-only. Written once all
`canary-instrument` code files exist so the grep is meaningful; the test's
`rglob` is evaluated live at test-run time, so later tasks (`SKILL.md`,
Task 7) are automatically covered by this same test on every subsequent
`pytest` run, no update needed here.

- [ ] **Step 1: Write the de-id test** (append; no `import` needed —
  this test only reads files from disk)

```python
def test_skill_dir_has_no_client_strings():
    # Split string literals so this file does not itself contain the
    # proprietary tokens it guards against. Scans .py/.md AND .mjs/.ts —
    # the repo-wide guard (scripts/check_removed_symbols.py) does not cover
    # .mjs/.ts, so this skill's own test is the only guard for
    # otel_bootstrap/*.
    banned = ("capi" "llary", "loop" "back", "op" "tum", "cap" "well")
    scanned_suffixes = (".py", ".md", ".mjs", ".ts")
    for path in _SKILL_DIR.rglob("*"):
        if path.is_file() and path.suffix in scanned_suffixes:
            text = path.read_text(encoding="utf-8").lower()
            for bad in banned:
                assert bad not in text, f"client string {bad!r} found in {path}"
```

- [ ] **Step 2: Run the test**

Run: `python -m pytest tests/unit/test_canary_instrument.py -k client_strings -v`
Expected: PASS immediately (Tasks 1–5 were already written de-identified;
this test is a guard, not a driver of new production code). If it fails,
grep the reported file/token and rename before proceeding — do not weaken
the banned-token list to make it pass.

- [ ] **Step 3: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add tests/unit/test_canary_instrument.py
git commit -m "test(canary-instrument): de-id guard for the shipped skill directory"
```

---

### Task 7: `SKILL.md` — invocation, wiring steps, discoverability test

**Depends on:** Task 6 | **Files:**
`agents/skills/claude-code/canary-instrument/SKILL.md`,
`tests/unit/test_canary_instrument.py` (append)

**Interfaces:**
- Consumes: `agent.core.skill_registry.SkillRegistry`.
- Produces: a discoverable, runnable bundled skill named
  `canary-instrument`.

- [ ] **Step 1: Write the failing test** (append)

```python
from agent.core.skill_registry import SkillRegistry  # noqa: E402


def test_skill_is_discoverable_and_runnable():
    skills = {s.name: s for s in SkillRegistry().discover()}
    assert "canary-instrument" in skills
    assert skills["canary-instrument"].is_executable
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/unit/test_canary_instrument.py -k discoverable -v`
Expected: FAIL — `canary-instrument` not found (no `SKILL.md` yet).

- [ ] **Step 3: Write `SKILL.md`**

Create `agents/skills/claude-code/canary-instrument/SKILL.md`:

````markdown
---
name: canary-instrument
description:
  Instrument a Playwright run with OpenTelemetry and emit a run.json
  artifact correlating every test to the outbound HTTP requests it made —
  "which test made which request?" — with zero manual bookkeeping in test
  code. Trace-only v1 contract, additive-safe for future pytest/k6/node
  producers. Self-contained (bundles its own dataclasses and span reader).
cli: scripts/cli.py
---

# Canary Instrument

Correlate every outbound HTTP request in a Playwright run to the test that
made it, using OTel span parent/child relationships. Zero required external
dependencies to produce output — default file-based span export, no OTel
collector needed.

## Setup (two manual steps, once per suite)

This skill ships fixture *files* you wire into your own suite — it does
not vendor OTel as a dependency of the `canary` package itself. Install
these first:

```bash
npm install --save-dev \
  @opentelemetry/sdk-node @opentelemetry/api \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

**1. Bootstrap the OTel SDK before Playwright starts** — add
`NODE_OPTIONS` to your test command (or `playwright.config.ts`'s
`webServer`/CI step):

```bash
NODE_OPTIONS="--import ./node_modules/canary/agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/instrument.mjs" \
  npx playwright test
```

Copy `otel_bootstrap/instrument.mjs` into your repo (e.g.
`otel/instrument.mjs`) if you'd rather not reference the path inside
`node_modules`.

**2. Merge the root-span fixture into your `fixtures.ts`:**

```ts
import { test as base } from '@playwright/test';
import { withTestSpan } from './otel_bootstrap/playwright-fixture';

export const test = withTestSpan(base);
```

Every test using this `test` export now opens a root span carrying
`test.id`/`test.title`/`test.file`, and every HTTP call the test makes
nests under it automatically — no manual span code in individual tests.

## Invocation

```bash
canary skills run canary-instrument -- \
  --spans test-results/trace --output test-results \
  [--suite-type e2e_ui]
```

Writes `test-results/run.json`. Creates `--output` if it doesn't exist.
Missing/empty `--spans` produces `trace: {spans_total: 0, by_test: []}`,
not a failure. `--suite-type` is a free-form string (no enum) — pass
whatever label describes your suite.

## `run.json` v1 contract (trace-only)

```jsonc
{
  "schema_version": 1,
  "suite_type": "",
  "generated_at": "2026-07-15T18:00:00+00:00",
  "trace": {
    "spans_total": 124,
    "by_test": [
      {
        "test_id": "users-spec:1",   // "__setup__" for orphan traffic
        "test_title": "lists users",
        "test_file": "tests/users.spec.ts",
        "trace_id": "abc123...",
        "outcome": "passed",
        "requests": [
          { "method": "GET", "url": "http://localhost:3000/users/1",
            "route": "/users/:id", "status": 200, "duration_ms": 12.4,
            "span_id": "def456...", "started_at": "2026-07-15T18:00:01+00:00" }
        ]
      }
    ]
  }
}
```

No `coverage` key, no `canary_run_id` key — cut for v1 (see
`docs/adr/0006-otel-test-side-tracing.md` and
`docs/changes/canary-instrument/proposal.md`). Additive-only evolution: new
optional fields may appear later; existing fields never change meaning.

## Sending spans to a collector (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` before the test run and spans are
*additionally* streamed there — the file exporter still writes
`test-results/trace/otel-spans.*.jsonl` either way, so
`canary-instrument`'s own correlation is never dependent on a collector
being up. If your org's endpoint is recorded in company-knowledge, export
it first:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="$(canary company-knowledge show --json | jq -r '.otel_exporter_endpoint')"
```

See `docs/guides/company-knowledge.md` for the `otel_exporter_endpoint`
field.

## CI wiring (GitHub Actions)

```yaml
- name: Run Playwright (instrumented)
  env:
    NODE_OPTIONS: "--import ./otel/instrument.mjs"
  run: npx playwright test --reporter=json --output-file=test-results/results.json

- name: Correlate tests to HTTP spans
  if: always()
  run: |
    canary skills run canary-instrument -- \
      --spans test-results/trace --output test-results

- name: Upload run.json
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: run-trace
    path: test-results/run.json
```

## Related skills

- `canary-test-reporter` — Markdown/JSON test summary; `run.json`'s
  `by_test[]` rows are structurally similar to its `TestResult` shape
  (title/status as join keys) — a future consumer can read both artifacts
  with one join key.
- `canary-fail-fast` — aborts a broken run early; use alongside this skill
  for complete CI coverage.
````

- [ ] **Step 4: Run tests + markdownlint to verify green**

Run: `python -m pytest tests/unit/test_canary_instrument.py -v`
Expected: PASS (24 tests: 22 from Tasks 1–4/6, this discoverability test,
and the de-id test now also matching `SKILL.md`'s content).
Run: `npx markdownlint-cli2 agents/skills/claude-code/canary-instrument/SKILL.md`
(or the repo's configured markdownlint command)
Expected: no errors.

Also confirm the CLI runs end to end:
Run: `python agents/skills/claude-code/canary-instrument/scripts/cli.py --spans /tmp/no-such-dir --output /tmp/canary-instrument-smoke`
Expected: prints `canary-instrument: wrote ... (0 spans, 0 test buckets)`;
exit 0; `/tmp/canary-instrument-smoke/run.json` exists with an empty trace.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/claude-code/canary-instrument/SKILL.md \
        tests/unit/test_canary_instrument.py
git commit -m "feat(canary-instrument): SKILL.md + discoverability test"
```

---

### Task 8: ADR — test-side-only tracing (Phase 1, SUT-side deferred)

**Category:** integration | **Depends on:** Task 4, Task 5 | **Files:**
`docs/adr/0006-otel-test-side-tracing.md`, `docs/adr/README.md` (add index
row)

**Note on path:** the spec names this file
`docs/specs/adr-otel-test-side-tracing.md`; this task uses this repo's
actual, established ADR convention instead — `docs/adr/NNNN-title.md` with
an index in `docs/adr/README.md` (5 prior ADRs already follow this
pattern; `docs/specs/` holds design specs, not ADRs). See the plan's
Uncertainties section. Flag at sign-off if the spec's literal path was
intentional.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0006-otel-test-side-tracing.md`:

```markdown
# ADR 0006 — Test-side-only OTel tracing (Phase 1, SUT-side deferred)

**Status:** accepted
**Date:** 2026-07-15
**Deciders:** Bri Stevenski (upstream maintainer)
**Related:** roadmap item "Overlay Upstreaming" → "OTel instrumentation
bootstrap"; `docs/changes/canary-instrument/proposal.md`

## Context

`canary-instrument` correlates each Playwright test to the outbound HTTP
requests it made, using OTel span parent/child relationships: a root span
opened per test (via a Playwright fixture) becomes the OTel active context,
so the test's own HTTP calls automatically nest as child spans of that
root. `span_reader.py` reads the resulting `otel-spans.*.jsonl` files and
resolves each trace's root via its `test.*` attributes.

This works because the *test process* is instrumented — the Node process
running Playwright, with `@opentelemetry/auto-instrumentations-node`
patching its own `http`/`undici` client calls. It says nothing about what
happens *inside* the system under test (SUT) once a request arrives:
whether the SUT propagates the trace context onward (to its own downstream
calls, a database, another service), or whether the SUT's own spans (if
any) get exported anywhere `canary-instrument` could read them.

A more complete tracing story would have the SUT also participate: accept
the inbound `traceparent` header, emit its own spans as children of the
inbound span, and export them somewhere `span_reader.py` (or a successor)
could merge in. That is a materially larger scope — it requires the SUT to
be instrumented (which `canary-instrument`, a *test-tooling* skill, does
not control), a shared or federated span sink, and correlation logic that
spans two independently-deployed processes.

## Decision

**Phase 1 (this skill, v1) instruments the test process only.** Spans come
from the Playwright/Node test runner's own HTTP client calls — never from
the SUT. `otel_bootstrap/instrument.mjs` and `playwright-fixture.ts` ship
as fixtures the *consumer's test suite* imports; nothing in this skill
touches, configures, or assumes anything about the SUT's runtime.

This is a reusable commitment, not just a v1 scope note: future pytest/k6/
plain-Node producers extending the `trace` block (see the `run.json`
contract's schema-version-stable extension point) inherit the same
boundary — they instrument their own test process, not the SUT. SUT-side
context propagation is explicitly out of scope until a concrete consumer
need exists.

## Consequences

### Immediate

- `canary-instrument` has zero coupling to the SUT's language, framework,
  or deployment shape — it works identically whether the SUT is a Node
  API, a Python service, or a third-party API this suite merely calls.
- The `run.json` contract's `by_test[].requests[]` entries describe the
  *outbound* view only (method/url/route/status/duration from the test's
  perspective). There is no SUT-side span data to merge, so no
  cross-process correlation logic is needed in `span_reader.py`.
- `coverage` (API route-hit coverage) was cut entirely from this skill
  for the same reason it's a separate roadmap item, not a `run.json`
  field: it requires knowing the SUT's actual route table, which is
  SUT-side knowledge this skill deliberately doesn't have.

### Follow-on

- If a future consumer needs full request lifecycles (test → SUT → its
  downstream calls), that is a new, larger skill (or a v2 schema bump to
  `run.json`'s `trace` block) — not a change to this ADR's boundary. The
  `trace` block's shape (list of typed producers keyed by `test_id`) is
  chosen so a v2 field can be additive.
- pytest/k6/plain-Node producers (deferred, non-goals in
  `docs/changes/canary-instrument/proposal.md`) will each instrument their
  own test process the same way — no ADR update needed to onboard them,
  since the boundary this ADR sets is per-test-process, not per-language.

### Risks

- **Incomplete picture for multi-hop requests.** If the SUT calls a
  second internal service, that hop is invisible to `run.json` — only the
  test's direct call is recorded. Mitigation: none in this skill; a
  future SUT-side tracing effort would need its own ADR when a real
  consumer asks for it.
- **Consumer confusion about "why doesn't `run.json` show my backend's
  spans?"** Mitigation: `SKILL.md` states plainly that this is
  test-side-only tracing.

### Reversibility

High. SUT-side tracing is purely additive — nothing in Phase 1's contract
or code needs to change to add it later; it would extend `run.json`'s
`trace` block or introduce a new top-level key.

## Alternatives Considered

### Alternative 1: Root span via a custom Playwright reporter

Rejected (see `docs/changes/canary-instrument/proposal.md` Decisions
table) — reporters run in Playwright's main process and can't establish
the OTel active context that makes HTTP child spans nest automatically.
The fixture approach (this ADR's mechanism) runs *in* the test's own
worker process, where the active-context propagation actually works.

### Alternative 2: Require SUT-side instrumentation from day one

Rejected for v1 — no roadmap item or spec success criterion asks for it,
and it would require this skill to make assumptions about the SUT's
language/framework/deployment that a generic, client-agnostic skill
should not make. Revisit only when a concrete consumer need exists
(YAGNI).

## Open Questions

None at this time — this ADR resolves cleanly to "test-side-only for v1,
additive extension point preserved."

## References

- `docs/changes/canary-instrument/proposal.md`
- `agents/skills/claude-code/canary-instrument/scripts/span_reader.py`
- `agents/skills/claude-code/canary-instrument/scripts/otel_bootstrap/`
- Roadmap: "Overlay Upstreaming" → "OTel instrumentation bootstrap"
```

- [ ] **Step 2: Add the index row**

In `docs/adr/README.md`, append to the `## Index` table:

```markdown
| [0006](0006-otel-test-side-tracing.md) | Test-side-only OTel tracing (Phase 1, SUT-side deferred) | accepted |
```

- [ ] **Step 3: Markdownlint + validate**

Run: `npx markdownlint-cli2 docs/adr/0006-otel-test-side-tracing.md docs/adr/README.md`
Expected: no errors.
Run: `harness validate`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0006-otel-test-side-tracing.md docs/adr/README.md
git commit -m "docs(adr): 0006 test-side-only OTel tracing (canary-instrument)"
```

---

### Task 9: `docs/guides/company-knowledge.md` — add `canary-instrument` as the first `otel_exporter_endpoint` usage example

**Category:** integration | **Depends on:** Task 7 | **Files:**
`docs/guides/company-knowledge.md`

- [ ] **Step 1: Add a "Usage examples" section**

In `docs/guides/company-knowledge.md`, insert a new section after
`## What gets injected into prompts` (before `## \`.canary/\` gitignore
note`):

````markdown
---

## Usage examples

Fields are validated and merged, but Canary itself never auto-consumes
most of them beyond the prompt-injection block above — skills that want a
pointer read it explicitly. `otel_exporter_endpoint` has one such consumer:

### `canary-instrument` — OTLP collector endpoint

The `canary-instrument` skill's `otel_bootstrap/instrument.mjs` reads the
standard `OTEL_EXPORTER_OTLP_ENDPOINT` env var directly — it has no code
dependency on this module. Populate that env var from company-knowledge
before your test run if you want spans additionally streamed to a
collector (the file-based export `canary-instrument` relies on for
correlation works either way):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="$(canary company-knowledge show --json | jq -r '.otel_exporter_endpoint')"
npx playwright test
```

See `agents/skills/claude-code/canary-instrument/SKILL.md` for the full
setup.
````

- [ ] **Step 2: Markdownlint**

Run: `npx markdownlint-cli2 docs/guides/company-knowledge.md`
Expected: no errors.

- [ ] **Step 3: Validate + commit**

Run: `harness validate`
Expected: PASS.

```bash
git add docs/guides/company-knowledge.md
git commit -m "docs(company-knowledge): canary-instrument as the otel_exporter_endpoint usage example"
```

---

### Task 10: Full-suite verification + docs-lint + open PR

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7,
Task 8, Task 9 | **Files:** none (verification-only)

- [ ] **Step 1: Run the full test suite**

Run: `python -m pytest -q`
Expected: PASS (existing suite + the ~24 new `canary-instrument` tests).

- [ ] **Step 2: Run docs-lint (residual removed-symbol + proprietary-string guard)**

Run: `python3 scripts/check_removed_symbols.py`
Expected: `check_removed_symbols: clean — no removed-symbol or proprietary
leaks.`, exit 0. Note this repo-wide guard does not scan `.mjs`/`.ts` (see
Global Constraints) — Task 6's dedicated de-id test is the real guard for
`otel_bootstrap/*`; this step covers `SKILL.md`, the ADR, and the doc
update.

- [ ] **Step 3: Run `harness validate`**

Run: `harness validate`
Expected: PASS.

- [ ] **Step 4: Grep the whole skill tree for residual client strings (belt-and-suspenders, matches Task 6's assertions manually)**

Run a case-insensitive grep of
`agents/skills/claude-code/canary-instrument/` for the same terms Task 6's
banned-token list guards against — expect no output.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/canary-instrument
gh pr create --title "feat(canary-instrument): OTel instrumentation bootstrap (overlay upstreaming)" \
  --body "Generalizes the private overlay's OTel instrumentation skill into a self-contained bundled skill. Correlates Playwright tests to their outbound HTTP spans via OTel parent/child relationships; trace-only run.json v1 contract (coverage and canary_run_id cut, YAGNI). Self-contained; no client strings (dedicated de-id test covers .py/.md/.mjs/.ts). See docs/changes/canary-instrument/."
```

Do **not** update `docs/roadmap.md`'s "OTel instrumentation bootstrap"
status in this PR — the spec explicitly defers that to ship time, outside
this plan.

---

## Self-Review

**Spec coverage:** `run_types.py` → Task 1. `span_reader.py` correlation
(grouping, root resolution, `__setup__`, multi-worker merge, malformed-line
skip) → Tasks 2–3. `cli.py` (argument surface, exit codes, dir creation,
`run.json` shape) → Task 4. `otel_bootstrap/instrument.mjs` +
`playwright-fixture.ts` (port/rename/de-id) → Task 5. De-id test (highest
priority per spec) → Task 6, standalone per spec's explicit ordering
(unlike the `canary-fail-fast`/`canary-test-reporter` precedent, which
combined the de-id test with the `SKILL.md` task — this spec calls it out
separately as item 5 of 8, ahead of `SKILL.md` at item 6). `SKILL.md` +
discoverability → Task 7. ADR → Task 8. `company-knowledge.md` update →
Task 9. Full-suite + docs-lint + PR → Task 10. All 13 spec success criteria
map to a task (see Observable Truths above); all 8 spec Implementation
Order phases map to a task (phase 2 split into Tasks 2–3 per the Iron
Law — the correlation logic's four distinct behaviors, one per success
criterion, don't fit one 2–5 minute task cleanly).

**Deviations from spec (flagged, not silently resolved):**
1. ADR path: `docs/adr/0006-otel-test-side-tracing.md` (+ README index),
   not the spec's literal `docs/specs/adr-otel-test-side-tracing.md` — see
   Uncertainties. This repo has an established, numbered `docs/adr/`
   convention (5 prior ADRs) that the spec's path doesn't follow;
   `docs/specs/` is for design specs, not decision records.
2. Spec's `docs/roadmap.md` "mark done" step is explicitly *not* included
   here — the spec's own Integration Points section says "marked done
   later at ship time, not here," which this plan honors (unlike the
   `canary-fail-fast` plan's Task 7, which did include a roadmap-done
   task — that plan predates this spec's explicit deferral).
3. `span_reader.py`'s OTel span JSON envelope shape is inferred, not
   pinned by the spec (which only shows the `run.json` output shape) —
   flagged as an ASSUMPTION in Uncertainties; low blast radius if wrong
   (isolated to a handful of private helper functions in Task 2).

**Placeholder scan:** none — every code step contains complete, runnable
code; every command has an expected output. Task 5's `.mjs`/`.ts` files
have no pytest coverage by design (spec criterion 13 excludes them) —
verification there is a syntax check (`node --check`) plus manual review
against `SKILL.md`'s documented contract, not a placeholder.

**Type consistency:** `RequestSpan`/`TestTrace`/`Trace`/`RunArtifact`
(Task 1) field names match `span_reader.py`'s construction (Task 2) and
`cli.py`'s `RunArtifact(...)` call (Task 4) exactly. `read_traces(Path |
str) -> Trace` signature is identical everywhere it's called (Task 2's
tests, Task 3's tests, Task 4's `cli.py`). `main(list[str] | None) -> int`
matches the `canary-fail-fast`/`canary-test-reporter` precedent signature.
Module name `cli` collision across three skills' test files is handled by
the `sys.modules` cache-clearing convention documented in the File Map.
