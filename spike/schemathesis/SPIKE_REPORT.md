# Schemathesis Spike Report

**Date:** 2026-06-01
**Branch:** `spike/schemathesis`
**Issue:** [#131](https://github.com/bop-clocktower/canary/issues/131)
**Tool version:** Schemathesis v4.21.0

---

## Objective

Time-boxed spike: run Schemathesis against one sample API endpoint in
read-only mode, measure defects found vs. the existing hand-written suite,
and decide whether to add Schemathesis to the `api` category in the framework
registry.

---

## Setup

Target: `POST /v1/checkout` from `examples/pytest-api-checkout`.

A minimal FastAPI implementation was written at `spike/schemathesis/app.py`
with the request/response contract from the example prompt. The OpenAPI 3.1.0
schema was generated automatically by FastAPI. The existing hand-written pytest
suite covers three cases: success (201), empty items (400), missing auth (401).

Schemathesis was run with `--checks all` and a valid Bearer token injected via
`--header` so auth failures didn't dominate.

```bash
schemathesis run http://localhost:8765/openapi.json \
  --url http://localhost:8765 \
  --checks all \
  --header "Authorization: Bearer spike-token" \
  --max-response-time 2000
```

---

## Results

**36 test cases generated in 1.08s. 3 unique failures found.**

### Finding 1 — API accepted schema-violating request (CRITICAL)

Schemathesis sent `{"items": [{"qty": false, "sku": ""}]}` — a boolean
where an integer is required. The API returned 201 instead of 422.

**Root cause:** FastAPI/Pydantic coerces `false` → `0` for `int` fields
in permissive mode. The API happily processes an order with `qty=0`.

**Existing suite coverage:** ❌ Not covered. The hand-written tests only
pass well-formed requests.

**Fix required:** Add `qty: int = Field(gt=0)` to enforce positive quantity.

---

### Finding 2 — API rejected schema-compliant request (MEDIUM)

Schemathesis sent `{"items": []}` — an empty array, which is valid per the
OpenAPI schema (no `minItems` constraint). The API returned 400. Per the
OpenAPI contract, `[]` is a valid value for an array field.

**Root cause:** The schema does not declare `minItems: 1`, so `[]` is
technically schema-valid even though the business logic rejects it.

**Existing suite coverage:** ✅ Partially — the hand-written suite tests the
400 response but doesn't flag the schema/implementation mismatch.

**Fix required:** Add `items: List[Item] = Field(min_length=1)` to the
request model, which will surface as `minItems: 1` in the generated schema.

---

### Finding 3 — Undocumented HTTP status code (LOW)

The 400 response from Finding 2 is not listed in the OpenAPI responses object
(only 201 and 422 are documented). Clients have no contract for error handling.

**Root cause:** FastAPI only documents the declared `response_model` status
code and the default 422 validation error. Custom `HTTPException` responses
need explicit `responses=` declarations in the route decorator.

**Fix required:** Add `responses={400: {"description": "Validation error"}, 401: {"description": "Unauthorized"}}` to the route.

---

## Comparison to the existing hand-written suite

| Case | Hand-written suite | Schemathesis |
|---|---|---|
| 201 success | ✅ | ✅ (implicit) |
| 400 empty items | ✅ | ✅ + found schema mismatch |
| 401 missing auth | ✅ | — (auth bypassed for coverage) |
| `qty=false` coercion bug | ❌ | ✅ **NEW** |
| Schema/docs mismatch (400 undocumented) | ❌ | ✅ **NEW** |

Schemathesis found **2 defects the hand-written suite missed** in 36 generated
cases and 1 second of runtime.

---

## Decision

**Adopt.** The defect-find rate justifies adding Schemathesis to the `api`
category in `registry.json`.

Rationale:
- It found a real coercion bug (qty=false → 0) that a hand-written suite
  wouldn't think to test — property-based input generation is the key
  differentiator.
- It surfaces schema/implementation drift (undocumented status codes,
  minItems mismatch) that code review typically misses.
- Setup is minimal: point it at an OpenAPI URL, get results in seconds.
- It's MIT-licensed and OSS-first. No API key. No service dependency.
- It complements, not replaces, the hand-written suite — different coverage
  dimension.

**Sequencing:** Add `schemathesis` to `registry.json` under `api` category
with `recommended_for: ["property-based API testing", "OpenAPI fuzz testing"]`,
alongside the existing `pytest` entry. Follow-up PR.

---

## Limitations of this spike

- The target was a purpose-built minimal app, not a real production API.
  Real APIs will have more complex auth, rate limiting, and stateful
  behaviour that Schemathesis's stateful mode can exercise further.
- The `--checks all` flag includes response time checks (set to 2s here)
  that may need tuning per environment.
- Schemathesis's stateful (OpenAPI links) mode was not exercised — requires
  linking `order_id` from the 201 response to downstream endpoints.
