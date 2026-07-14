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

````text
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
````

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
