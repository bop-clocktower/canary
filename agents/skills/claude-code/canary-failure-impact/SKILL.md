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
`canary guardian analyze` (`ts/src/guardian/`, wired to
`canary guardian analyze` in `ts/src/cli.ts`) is a **real OpenAPI-diff
blast-radius engine** — it diffs two OpenAPI specs (`--spec-before` /
`--spec-after`), extracts the actual added/removed/changed endpoints, and maps
each to coverage gaps against a `coverage-report.json`. For the class of change
it covers, guardian is strictly higher-fidelity than the heuristics here.

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

### Step 5 — user catalog investigation

When a test failure in the target path involves an auth, permission, or
configuration error, ask the **existence** question before the substitution
question. "Do the accounts this repo is configured with still exist?" is what
actually resolves this failure mode; "which user could I try instead?" quietly
implies the configured ones are fine, which is the opposite of what is true when
accounts have been decommissioned upstream.

#### Step 5a — verify the configured accounts still exist

1. Read `user_catalog_skill` from `.canary/company.json` (a first-class field of
   `CompanyKnowledge`, so `canary company-knowledge show` reports it and the
   `.canary/company.<env>.json` cascade applies).
2. Resolve the accounts the repo is already configured with from the failure
   context and the suite's fixtures or environment.
3. If a catalog skill is declared, invoke
   `canary skills run <user_catalog_skill>` to list the accounts the catalog
   knows.
4. Pass both lists plus the declared slug to `verifyConfiguredAccounts` from
   `ts/src/core/company-knowledge.ts`, and report its `headline`:

   | Status          | How to report it                                                                                                                                 |
   | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `all-missing`   | A near-certain diagnosis. State it as an account provisioning problem, not a test defect, and stop investigating the suite until it is resolved. |
   | `some-missing`  | Name each missing account; tests depending on them fail for an account reason.                                                                   |
   | `all-present`   | Accounts are not the cause. Continue to step 5b.                                                                                                 |
   | `cannot-verify` | An abstention, never a pass. Report the verdict's `reason` verbatim.                                                                             |

**Never report "accounts fine" from a check that did not run.** A
`cannot-verify` verdict means zero accounts were compared, and zero checked is
not a clean result.

#### Step 5b — suggest an alternative user

Only once step 5a returned `all-present` or `cannot-verify`:

1. If a catalog skill is declared: invoke it with the required attributes from
   the error context; surface any matching user as a suggestion.
2. If absent, or no matching user found: present constructively —

   > "This failure may be a test user or test data configuration issue. Check
   > your user catalog if you have one, or set up the required test data before
   > re-running."

Never reference a specific catalog skill by name in output.

## Output Format

```text
Failure impact — src/loyalty/points.service.ts::accruePoints

  Severity: HIGH

  If this breaks undetected:
  · Members see incorrect balance in the partner portal  (user-facing)
  · Points journal diverges from the ledger  (data integrity)
  · Downstream: redemption.service.ts · tier-upgrade.service.ts ·
    reporting.service.ts  (3 dependents)

  Priority: write failure-path tests before next release
  Suggested: /canary-write-test "test failure paths for accruePoints"
```

## Related skills

- `/canary-critical-areas` — produces `critical-areas.json` used for focus

- `/canary-ci-ready` — uses the same user-catalog investigation pattern

- `/canary-write-test` — generates tests for the identified high-impact gaps

- `/canary-test-pipeline` — Phase 3

- `canary guardian analyze` (CLI, `ts/src/guardian/`) — higher-fidelity
  OpenAPI-diff blast-radius engine; use instead of this skill's heuristics when
  the change is an API/schema change with before/after specs available
