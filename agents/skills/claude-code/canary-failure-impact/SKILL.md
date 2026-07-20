---
name: canary-failure-impact
description: >
  For a given test, function, or code path, traces downstream effects and
  produces a severity label. Investigates config/auth failures using the
  consuming repo's declared user_catalog_skill. Optionally focuses on critical
  paths when critical-areas.json is present.
---

# Canary: Failure Impact

Answers "what actually breaks if this code fails and no test catches it?"
Produces a severity label and a concrete description of downstream effects to
help prioritise where to invest test coverage.

## When to Use

- Before deciding which gap to close first: "which of these matters most?"

- When a test fails and you need to understand the blast radius

- As Phase 3 of `/canary-test-pipeline`

- When asked "what's the impact if this breaks?"

## This skill vs. `canary guardian analyze`

This skill discovers downstream dependents with harness's `compute_blast_radius`
primitive when the MCP is present (degrading to plain `grep -r` when it is not),
then applies a **domain-keyword heuristic** (Steps 3–4 below) to turn that
dependent set into a severity label. The severity labeling is the heuristic part
— keyword matching over dependent file and function names.
`canary guardian analyze` (`agent/guardian/`, wired to `canary guardian analyze`
in `agent/cli.py`) is a **real OpenAPI-diff blast-radius engine** — it diffs two
OpenAPI specs (`--spec-before` / `--spec-after`), extracts the actual
added/removed/changed endpoints, and maps each to coverage gaps against a
`coverage-report.json`. For the class of change it covers, guardian is strictly
higher-fidelity than the heuristics here.

- **Use `canary guardian analyze`** when the change is an API/schema change and
  you have (or can generate) before/after OpenAPI specs — it gives exact
  endpoint-level impact and coverage-gap data instead of a keyword guess.
- **Use this skill** for everything guardian doesn't cover: non-API code paths
  (services, UI components, internal functions), impact tracing where no OpenAPI
  spec exists, or when you need the broader billing/auth/compliance
  domain-severity labeling in Step 3 rather than a strict API diff.

They are complementary, not competing — do not duplicate guardian's spec-diff
logic here if an OpenAPI change is in scope; delegate to
`canary guardian analyze` instead.

## Input

Provide one of:

- A test file path: `tests/loyalty/points.spec.ts`

- A function name: `accruePoints`

- A code path: `src/loyalty/points.service.ts`

If `.canary/critical-areas.json` is present, focus tracing on paths with
`risk_score ≥ 0.7`.

## Tracing Logic

### Step 1 — Identify the code path

Resolve the input to a specific file and function. If ambiguous, ask before
proceeding.

### Step 2 — Walk downstream dependents

**With harness MCP available:** call `compute_blast_radius` for the target file
(`file`, `mode: "detailed"`). It simulates cascading failure with a
probability-weighted BFS and returns each affected node with a cumulative
failure probability — this is the purpose-built blast-radius primitive, so use
it instead of hand-walking `get_relationships` hop-by-hop. Feed the returned
node set into Step 3, and let the cumulative probability weight the severity
(high-probability nodes dominate). When you additionally need the affected set
grouped by kind (tests vs docs vs code), call `get_impact` for the same target.

**Fallback:** use `grep -r` to find files that import or call the target. Limit
to direct dependents (1 hop) when MCP is unavailable.

### Step 3 — Classify each dependent by domain

Apply these heuristics to the dependent paths and function names:

| Domain signal                           | Severity modifier                   |
| --------------------------------------- | ----------------------------------- |
| billing / payment / charge / invoice    | +2 (financial impact)               |
| auth / session / token / permission     | +2 (security/access)                |
| compliance / audit / PHI / PII / HIPAA  | +2 (regulatory)                     |
| data / persist / write / store / commit | +1 (data integrity)                 |
| UI / render / display / format / label  | −1 (user-facing only, no data risk) |

### Step 4 — Aggregate to severity label

Base score starts at 2 (Medium). Sum modifiers from step 3. Cap at 4 (Critical).

| Score | Label    |
| ----- | -------- |
| 5+    | Critical |
| 3–4   | High     |
| 2     | Medium   |
| 0–1   | Low      |

### Step 5 — User catalog investigation

When a test failure in the target path involves an auth, permission, or
configuration error:

1. Read `user_catalog_skill` from `.canary/company.json`
2. If present: invoke `canary skills run <user_catalog_skill>` with the required
   attributes from the error context
3. If a matching user/config is found: surface it as a suggestion
4. If absent or no match: present constructively —

   > "This failure may be a test user or test data configuration issue. Check
   > your user catalog if you have one, or set up the required test data before
   > re-running."

## Output Format

````text
Failure impact — src/loyalty/points.service.ts::accruePoints

  Severity: HIGH

  If this breaks undetected:
  · Members see incorrect balance in the partner portal  (user-facing)
  · Points journal diverges from the ledger  (data integrity)
  · Downstream: redemption.service.ts · tier-upgrade.service.ts ·
    reporting.service.ts  (3 dependents)

  Priority: write failure-path tests before next release
  Suggested: /canary-write-test "test failure paths for accruePoints"
```text

## Related skills

- `/canary-critical-areas` — produces `critical-areas.json` used for focus

- `/canary-ci-ready` — uses the same user-catalog investigation pattern

- `/canary-write-test` — generates tests for the identified high-impact gaps

- `/canary-test-pipeline` — Phase 3

- `canary guardian analyze` (CLI, `agent/guardian/`) — higher-fidelity
  OpenAPI-diff blast-radius engine; use instead of this skill's heuristics
  when the change is an API/schema change with before/after specs available
````
