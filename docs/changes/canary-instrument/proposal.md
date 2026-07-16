# Canary Instrument — Overlay Upstreaming

**Status:** proposed (design sign-off pending)
**Type:** feature (bundled executable skill) — new production code + tests
**Keywords:** otel, opentelemetry, tracing, instrumentation, playwright,
run-json, overlay-upstreaming, bundled-skill, self-contained, canary-instrument

## Overview and goals

Generalize the private overlay's OTel instrumentation skill into a
client-agnostic, bundled Canary skill named **`canary-instrument`**. It
instruments a Playwright test run with OpenTelemetry and emits a `run.json`
artifact correlating each test to the outbound HTTP requests it made — "which
test made which request?" — with zero manual bookkeeping in test code.

**Goals:**

1. Correlate every outbound HTTP request in a Playwright run to the test that
   made it, using OTel span parent/child relationships.
2. Ship a `run.json` v1 contract (trace-only in this v1) that is additive-safe
   for future pytest/k6/node producers, matching the roadmap's original
   multi-framework ask.
3. Zero required external dependencies to produce output — default file-based
   span export, no OTel collector needed.
4. Fully de-identified: no client/employer-specific strings; reuses the
   already-merged generic `otel_exporter_endpoint` company-knowledge field for
   the opt-in OTLP path.

**Non-goals (this v1):**

- pytest, k6, and plain-Node producers. The `trace` block's shape is chosen to
  extend to them without a schema-version bump, but their fixtures are not
  built in this pass.
- API coverage (`coverage` block). This was a separate feature in the private
  design, coupled to a proprietary OpenAPI/route-matching coverage engine that
  this roadmap item never asked for. Not shipped even as a reserved `null`
  field — a real, generic HTTP-coverage skill is a separate future roadmap
  item if ever pursued.
- Auto-populating `OTEL_EXPORTER_OTLP_ENDPOINT` from company-knowledge before
  a test run. Consumer's responsibility, documented in `SKILL.md`.
- A `canary_run_id` / `--run-id` field for correlating `run.json` to an
  external run identifier. No goal or criterion in this spec requires it —
  cut per YAGNI (soundness review S6-001); add back if a real consumer (e.g.
  a future dashboard/TCM skill) needs it.

## Assumptions

- **Runtime:** Node.js >= 18 LTS (ESM `--import` support) for
  `otel_bootstrap/instrument.mjs`.
- **Playwright:** >= 1.10 (`test.extend` with `auto: true` fixtures).
- **Consumer supplies its own OTel npm dependencies** — `@opentelemetry/sdk-node`,
  `@opentelemetry/api`, `@opentelemetry/auto-instrumentations-node`,
  `@opentelemetry/exporter-trace-otlp-http`. This skill ships fixture *files*
  the consumer copies/imports into their own suite; it does not vendor these
  as a dependency of the canary package itself.
- **Shared local filesystem across parallel workers within one CI job.**
  Worker span files (`otel-spans.<worker>.jsonl`) are read from one directory;
  this does not work across distributed runners writing to separate disks
  without a shared artifact volume.

## Decisions made

| Decision | Rationale |
| --- | --- |
| **v1 covers Playwright/Node only** | Contract (`trace` block) is shaped to extend to pytest/k6/node later without a schema-version bump; those fixtures are simply not built yet. |
| **Root span via fixture merge, not a custom reporter** | Reporters run in Playwright's main process and can't establish the OTel active-context that makes HTTP child spans nest automatically — that's the mechanism the whole correlation trick depends on. |
| **`coverage` block cut entirely — not shipped even as `null`** | It was a separate feature in the private design, coupled to a proprietary route-matching coverage engine the roadmap item never asked for. |
| **`suite_type` stays a free-form string, no enum** | The private schema's enum values mix generic test-taxonomy terms with a company product name. The public contract doesn't enumerate — callers pass whatever string describes their suite. |
| **`canary_run_id` cut for v1** | No goal or criterion requires it (soundness review S6-001, resolved: cut, re-add when a real consumer exists). |
| **OTLP endpoint sourced from the existing `otel_exporter_endpoint` company-knowledge field, but not auto-exported by this skill** | `agent/core/company_knowledge.py` already validates and merges this field with zero consumers today. `instrument.mjs` reads the standard `OTEL_EXPORTER_OTLP_ENDPOINT` env var directly — it has no code dependency on `company_knowledge.py`. Populating that env var from company-knowledge before the test run is the consumer's job, documented in `SKILL.md` as a usage pattern, not built as new plumbing here. |
| **Self-contained bundle**, no dependency on any other skill | Matches `canary-fail-fast` / `canary-test-reporter` precedent. |
| **Dedicated de-id test** greps the shipped skill directory for residual company-specific strings | Same guard `canary-fail-fast` uses; this skill's design was read from a private corporate repo (explicitly authorized for this task), so it carries real leak risk the other overlay-upstream skills didn't. |
| **Design read from the private overlay repository (read-only reference)**, renamed and stripped of coverage/company strings, not copied verbatim | Authorized for this task specifically; nothing is copied without a rename pass, and the coverage half is dropped rather than ported-then-scrubbed. |

## Technical design

**File layout** (mirrors `canary-fail-fast` / `canary-test-reporter`):

```text
agents/skills/claude-code/canary-instrument/
  SKILL.md
  scripts/
    __init__.py
    cli.py                        # entry point (SKILL.md `cli:` field)
    run_types.py                  # RunArtifact/Trace/TestTrace/RequestSpan dataclasses
    span_reader.py                # jsonl span merge + trace-id correlation
    otel_bootstrap/
      instrument.mjs              # Node OTel SDK bootstrap + file exporter
      playwright-fixture.ts       # withTestSpan() root-span fixture
```

**`run.json` v1 contract (trace-only):**

```jsonc
{
  "schema_version": 1,
  "suite_type": "",             // free-form string, caller's choice, no enum
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

No `coverage` key at all — dropping it entirely means the contract doesn't
carry a phantom always-null field. Additive-only evolution rule applies (new
optional fields may appear later; existing fields never change meaning).

**`run_types.py`** — `RequestSpan`, `TestTrace`, `Trace`, `RunArtifact`
dataclasses. `RunArtifact.to_dict()` is a plain `dataclasses.asdict()` call.

**`span_reader.py`** — globs `otel-spans.*.jsonl` in a directory, parses one
span per line, groups by `traceId`, resolves each trace's root via the
presence of `test.*` attributes, attaches HTTP child spans to that root's
test, and buckets HTTP spans from traces with no test root under the
synthetic id `"__setup__"`. Malformed/torn lines (e.g. a crashed worker's
final partial write) are skipped rather than raised.

**`otel_bootstrap/instrument.mjs`** — Node OTel SDK bootstrap. Default file
exporter writes one JSON span per line to
`test-results/trace/otel-spans.<TEST_WORKER_INDEX>.jsonl` (no collector
required). When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans are *additionally*
streamed to that collector via `OTLPTraceExporter` — the file path remains
what `span_reader.py` reads. Auto-instruments HTTP/undici only (fs
instrumentation disabled to avoid noise).

**`otel_bootstrap/playwright-fixture.ts`** — `withTestSpan(base)` wraps a
Playwright test object with an `auto` fixture that opens one root span per
test (carrying `test.id`/`test.title`/`test.file`), activates it as the OTel
active context so the test's HTTP calls become child spans, and closes it in
teardown with `test.outcome` set from `testInfo.status`.

**`cli.py`:**

```bash
canary skills run canary-instrument -- \
  --spans test-results/trace --output test-results \
  [--suite-type e2e_ui]
```

Writes `test-results/run.json` only. Creates `--output` if it doesn't exist.
Missing/empty `--spans` produces `trace: {spans_total: 0, by_test: []}`, not a
failure.

## Integration Points

### Entry Points

- New bundled skill `canary-instrument` at
  `agents/skills/claude-code/canary-instrument/`, invoked via
  `canary skills run canary-instrument -- ...` (CLI entry: `scripts/cli.py`).
- Two fixture artifacts consumers wire into their own suites (not new canary
  CLI surface): `otel_bootstrap/instrument.mjs` (via
  `NODE_OPTIONS="--import .../instrument.mjs"`) and
  `otel_bootstrap/playwright-fixture.ts` (merged into the consumer's
  `fixtures.ts`).

### Registrations Required

- None. Bundled skills under `agents/skills/claude-code/` are auto-discovered
  — confirmed by `canary-fail-fast` and `canary-test-reporter` shipping
  without a manifest/index entry.

### Documentation Updates

- New `SKILL.md` documents invocation, the two manual setup steps, and the
  `run.json` v1 contract inline (matching prior overlay-upstream skills — no
  separate contract doc needed for a single-producer v1).
- `docs/guides/company-knowledge.md` — add this skill's `SKILL.md` as the
  first documented usage example of `otel_exporter_endpoint` (currently
  documented but consumer-less); phrased as a usage cross-reference, not a
  code dependency (`instrument.mjs` never imports `company_knowledge.py`).
- `docs/roadmap.md` — promoted to `planned` at the end of this brainstorming
  session; marked `done` later at ship time, not here.

### Architectural Decisions

- **Test-side-only tracing (Phase 1, SUT-side deferred)** — standalone ADR
  (`docs/specs/adr-otel-test-side-tracing.md`), written fresh for the public
  repo. Reusable commitment future pytest/k6/node extensions inherit: spans
  come from instrumenting the test process, not the SUT; SUT-side context
  propagation is out of scope until a concrete need exists.

### Knowledge Impact

- `run.json`'s `by_test[]` rows are structurally similar to the flat
  `TestResult` shape from `canary-test-reporter` (title/status as join keys,
  future TCM feed). Worth a `docs/knowledge/` note once both skills exist so
  a future TCM integration sees the pattern once instead of rediscovering it
  per-skill. Flagged as a follow-up, not built now (YAGNI for this spec).

## Success Criteria

1. `canary skills run canary-instrument -- --spans <dir> --output <dir>`
   writes a `run.json` matching the v1 contract exactly (`schema_version: 1`,
   no `coverage` key, no `canary_run_id` key, `trace` block populated).
2. `span_reader.read_traces()` correctly correlates a synthetic multi-worker
   span fixture: HTTP child spans attach to their trace's `test.*`-attributed
   root; a trace with no root buckets under `__setup__`.
3. `spans_total` always reconciles: equals the sum of every
   `by_test[].requests` length plus the `__setup__` bucket's request count.
4. Multiple `otel-spans.<worker>.jsonl` files (parallel Playwright workers)
   are merged into one `Trace` without collision.
5. Missing/empty `--spans` directory produces a valid `run.json` with
   `trace: {spans_total: 0, by_test: []}` — not a hard failure.
6. `--suite-type` is accepted as an arbitrary string (no enum validation) and
   passed through verbatim.
7. Running with no `OTEL_EXPORTER_OTLP_ENDPOINT` set produces a complete
   `run.json` via the file exporter only — no network calls, no collector
   required.
8. Malformed/torn JSONL lines (e.g. a crashed worker's last line) are skipped
   by `span_reader.py` rather than raising.
9. `--output` directory is created if it doesn't already exist.
10. **De-id test** greps the entire `canary-instrument` skill directory for
    residual company-specific strings — zero hits. Highest-priority test
    given this skill's design was read from a
    private corporate repo.
11. `SKILL.md` documents both manual wiring steps (`NODE_OPTIONS` import +
    fixture merge) clearly enough that a consumer can set up tracing from the
    doc alone, no source-reading required.
12. `harness validate` passes; `scripts/check_removed_symbols.py` (docs-lint)
    passes.
13. Dedicated test suite covers `run_types.py` (serialization, `coverage` and
    `canary_run_id` keys genuinely absent) and `span_reader.py` (correlation
    logic, malformed-line handling, multi-worker merge) with meaningful
    assertions — smaller than `canary-fail-fast`'s 34 tests since the
    coverage half is cut and the `.mjs`/`.ts` bootstrap files are runtime
    fixtures, not independently unit-testable Python logic.

## Implementation Order

1. **`run_types.py`** — dataclasses, TDD against the trimmed contract (no
   coverage, no run_id).
2. **`span_reader.py`** — port + adapt; TDD the correlation logic (grouping,
   root resolution, `__setup__` bucket, multi-worker merge, malformed-line
   skip) against synthetic `.jsonl` fixtures.
3. **`cli.py`** — wire `run_types` + `span_reader` into the trimmed argument
   surface; TDD exit codes, directory creation, and `run.json` output shape.
4. **`otel_bootstrap/instrument.mjs`** + **`playwright-fixture.ts`** — port,
   rename, de-identify comments.
5. **De-id test** — written last, once all files exist, so the grep covers
   the final tree.
6. **`SKILL.md`** — written after implementation is stable, documenting the
   real invocation and setup steps.
7. **ADR** (`docs/specs/adr-otel-test-side-tracing.md`) — written alongside
   `SKILL.md`.
8. **`docs/guides/company-knowledge.md`** update — add the consumer example.
