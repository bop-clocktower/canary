# canary-test-reporter — Design Spec

<!-- markdownlint-disable-file MD013 -->

**Status:** approved
**Date:** 2026-07-13
**Type:** feature (bundled executable skill) — new production code + tests
**Keywords:** test-reporter, overlay-upstreaming, playwright, ci, markdown,
json, bundled-skill, self-contained, canary-test-reporter

---

## Overview and goals

Generalize the private overlay's test-reporter skill into a client-agnostic,
bundled Canary skill named **`canary-test-reporter`**. It reads a Playwright
JSON results file and emits a human-readable **Markdown** report and/or a
machine-readable **JSON** artifact — giving CI pipelines both a readable log
summary and a structured output for downstream tooling.

**Scope (this skill):**

- Playwright JSON → Markdown report (stdout or file)
- Playwright JSON → JSON report (file)
- Full result classification: passed / failed / flaky / skipped
- Non-zero exit when `failed > 0`

**Explicitly out of scope (follow-on work):**

- Slack webhook summary — deferred
- Per-branch run history — deferred (stateless by design)
- `@known-failure` quarantine ledger — deferred
- Request/response capture for API failures — Playwright JSON does not contain
  network data; this belongs in a future `canary-bug-hunt` skill that reads
  Playwright trace files (`.zip`) and correlates failed tests to their network
  activity

---

## Decisions made

| Decision | Choice | Rationale |
| --- | --- | --- |
| Output formats | Markdown + JSON only | 80/20 cut; HTML and Slack are follow-on |
| Quarantine ledger | Deferred | Meaningful feature on its own; keeps this shippable |
| Per-branch history | Deferred (stateless) | History storage adds edge cases orthogonal to core report; JSON output is the handoff for external history |
| Parser coupling | Self-contained | Both skills serve different parser contracts (failures-only vs. full summary); portable folder is the point of upstreaming |
| CLI output flags | File-centric with stdout fallback | Explicit paths for CI artifact wiring; stdout fallback for local ergonomics |
| Exit code | Non-zero on `failed > 0` | Flakes/skips do not fail the step; consistent with fail-fast contract |

---

## Structure

```text
agents/skills/claude-code/canary-test-reporter/
  SKILL.md           <- cli: scripts/cli.py; usage + CI wiring docs
  scripts/
    __init__.py
    cli.py           <- arg parsing, orchestration, exit code
    parse.py         <- full-fidelity Playwright JSON -> ReportData
    render.py        <- Markdown renderer
    json_report.py   <- JSON serializer
```

Five files, same shape as `canary-fail-fast`. Fully self-contained — zero
imports outside the `scripts/` directory. Discoverable via `canary skills list`
and runnable via `canary skills run canary-test-reporter -- …`.

---

## Data model

```python
@dataclass
class TestResult:
    title: str
    status: str          # "passed" | "failed" | "flaky" | "skipped"
    file: str | None
    line: int | None
    duration_ms: int | None
    error: str | None    # last error message; None for non-failures

@dataclass
class ReportData:
    total: int
    passed: int
    failed: int
    flaky: int
    skipped: int
    duration_ms: int     # sum of all test durations
    results: list[TestResult]
```

`ReportData` is the single object flowing from `parse.py` → `render.py` and
`json_report.py`. Both renderers only see this contract — they never touch raw
Playwright JSON.

**Classification logic:**

- `passed` — Playwright status `passed` / `expected`
- `failed` — status `failed` / `unexpected` with **no** passing retry
- `flaky` — status `failed` / `unexpected` with **at least one** passing retry
- `skipped` — status `skipped` / `pending`

This reuses the same flake-exclusion semantics as `canary-fail-fast`, keeping
behaviour consistent across the two skills.

**Future TCM note:** `TestResult` is intentionally flat (all scalar fields) so
it maps cleanly to a QA tracker / TCM SQLite row. `title` is the natural join
key; `status` and `duration_ms` are the per-run metric columns. The JSON output
is the intended handoff format when that integration is built.

---

## CLI surface

```bash
# Markdown to stdout (default when no output flags given):
canary skills run canary-test-reporter -- --results test-results/results.json

# Markdown to file:
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --markdown-out report.md

# JSON to file:
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --json-out report.json

# Both at once (most common CI usage):
canary skills run canary-test-reporter -- \
  --results test-results/results.json \
  --markdown-out report.md \
  --json-out report.json
```

| Flag | Required | Default |
| --- | --- | --- |
| `--results <path>` | yes | — |
| `--markdown-out <path>` | no | stdout if `--json-out` also absent |
| `--json-out <path>` | no | — |

**Exit code:** `1` when `failed > 0`, else `0`.

---

## Markdown report format

````markdown
# Test Report

**2 failed · 1 flaky · 14 passed · 1 skipped** · 38 tests · 12.4s

## Failed (2)

### auth > login > should reject bad password

`tests/auth.spec.ts:42`

```text
Expected: 401
Received: 200
```

### checkout > payment > should decline expired card

`tests/checkout.spec.ts:88`

```text
Error: Timeout 30000ms exceeded
```

## Flaky (1)

- `tests/search.spec.ts:17` — search > autocomplete > should debounce input

## Summary

| Status    | Count  |
| --------- | ------ |
| Passed    | 14     |
| Failed    | 2      |
| Flaky     | 1      |
| Skipped   | 1      |
| **Total** | **38** |
````

- Error snippets are capped at 10 lines to avoid log floods
- Flaky tests listed without error detail (passed on retry; error is noise)
- Skipped tests counted in summary only, not enumerated
- Sections with zero items are omitted entirely (e.g. no `## Flaky` block
  when `flaky == 0`)

---

## JSON contract

```json
{
  "version": 1,
  "generated_at": "2026-07-13T20:07:00Z",
  "summary": {
    "total": 38,
    "passed": 14,
    "failed": 2,
    "flaky": 1,
    "skipped": 1,
    "duration_ms": 12400
  },
  "results": [
    {
      "title": "auth > login > should reject bad password",
      "status": "failed",
      "file": "tests/auth.spec.ts",
      "line": 42,
      "duration_ms": 1823,
      "error": "Expected: 401\nReceived: 200"
    }
  ]
}
```

- `version: 1` pins the contract for future TCM integration
- `results` includes **all** tests (not just failures) so downstream tools
  can compute their own aggregates
- `generated_at` is UTC ISO-8601
- `error` is `null` for non-failed results

---

## Testing approach

All tests in `tests/unit/test_canary_test_reporter.py`, importing directly
from the skill's `scripts/` directory. No mocks — all tests use `tmp_path`
fixtures and real in-memory Playwright JSON structures. Target: ~35 tests.

**Coverage targets:**

| Module | What to test |
| --- | --- |
| `parse.py` | passed/failed/flaky/skipped classification; duration extraction; missing file returns empty; malformed JSON raises; non-object top-level raises; flake exclusion (retry present); nested suites |
| `render.py` | header line format; Failed block with error snippet; error truncation at 10 lines; Flaky list (no error detail); skipped count only; zero-failure report omits Failed section; zero-flaky omits Flaky section |
| `json_report.py` | output structure; `version` field present; `generated_at` is valid ISO-8601; all four statuses round-trip; `error` is null for passed tests |
| `cli.py` | `--markdown-out` writes file; `--json-out` writes file; both flags together; stdout fallback when neither flag given; missing `--results` exits 1; results file not found exits 1; exit 1 on failures; exit 0 on all-pass |
| de-id | grep `scripts/` for any proprietary strings (same guard as `canary-fail-fast`) |

---

## CI wiring (GitHub Actions)

```yaml
- name: Run Playwright
  run: >-
    npx playwright test
    --reporter=json
    --output-file=test-results/results.json

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

---

## Related skills

- `canary-fail-fast` — fast/loud CI failure digest; complementary
  (fail-fast aborts early, reporter summarises at run-end)
- `canary-bug-hunt` *(future)* — trace-file correlation for API call
  failures; reads Playwright `.zip` traces alongside JSON results
