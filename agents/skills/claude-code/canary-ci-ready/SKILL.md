---
name: canary-ci-ready
description: >
  Analyses a test suite for CI readiness: coverage depth, flakiness, assertion
  quality, critical path coverage, and suite runtime. Accepts documented failures
  (quarantined tests with linked open issues count as verified). Investigates
  config/auth failures using the consuming repo's declared user_catalog_skill.
---

# Canary: CI Ready

Analyses a test suite across five dimensions and produces a readiness score.
Use this before promoting a suite to CI, or as the convergence gate in
`/canary-test-pipeline`.

## When to Use

- Before wiring a new test suite into CI for the first time
- When a CI run is failing and you need to understand why
- As part of `/canary-test-pipeline` (Phase 0 and convergence gate)
- When asked "is this suite ready for CI?"

## The Five Checks

Run all five checks and score each pass / warn / fail.

### 1. Coverage depth

Read `.canary/test-inventory.json` if present. If absent or older than 7 days,
run `canary coverage` to generate fresh data.

Default threshold: depth ≥ 2 for all endpoints in critical areas. Override with
`--threshold <n>`.

- **pass** — all critical-area endpoints at depth ≥ threshold
- **warn** — some endpoints at depth 1 (hit but unasserted)
- **fail** — any critical-area endpoint at depth 0

### 2. Flakiness

Read `test-results/quarantine-ledger.json` (or the path in
`.canary/company.json` under `quarantine_ledger_path` if set).

A quarantined test is acceptable only when it has a linked open issue (Jira or
GitHub). Check issue state:

- Linked issue **open** → counts as verified (documented, tracked)
- Linked issue **closed** → flag: quarantine should be resolved
- **No linked issue** → fail: unlinked quarantine blocks CI-ready

### 3. Assertion quality

Read depth scores from the inventory. In critical-area endpoints:

- **pass** — all tests at depth ≥ 2 (shaped assertions: result.ok or equivalent)
- **warn** — some tests at depth 1 (status-only assertions)
- **fail** — majority of critical-path tests at depth 1

### 4. Critical path coverage

Only run this check if `.canary/critical-areas.json` is present.

Cross-reference the top 5 risk-scored areas from `critical-areas.json` against
`test-inventory.json`:

- **pass** — all top-5 areas have at least one test at depth ≥ 1
- **warn** — one area uncovered
- **fail** — two or more top areas uncovered
- **skip** — `critical-areas.json` absent (note this in output, not a failure)

### 5. Suite runtime

Read `test-results/run-history.ndjson`. Use the p95 of the last 10 runs.

- **pass** — p95 under the configured timeout (default: 5 minutes)
- **warn** — p95 between 5–10 minutes
- **fail** — p95 over 10 minutes, or no run history (cannot assess)

## User Catalog Investigation

When a test fails with an auth, permission, or configuration error:

1. Read `user_catalog_skill` from `.canary/company.json`
2. If present: invoke `canary skills run <user_catalog_skill>` with the
   required attributes from the error context; surface any matching user as a
   suggestion
3. If absent, or no matching user found: present constructively —

   > "This failure may be a test user or test data configuration issue.
   > Check your user catalog if you have one, or set up the required test data
   > before re-running."

Never reference a specific catalog skill by name in output.

## Output Format

```
CI Readiness — <repo-name>

  ✓ / ⚠ / ✗   <check name>   <brief finding>
  ...

  Score: N/5 — CI-READY  or  NOT CI-READY

  <gap list with suggested next actions>
```

Score of 5/5 = CI-READY. Any fail = NOT CI-READY. Warns do not block.

## Flags

- `--threshold <n>` — minimum depth for coverage check (default: 2)

## Related skills

- `/canary-test-pipeline` — orchestrates this skill as Phase 0 and convergence gate
- `/canary-critical-areas` — produces `critical-areas.json` used by check 4
- `canary-unquarantine` (overlay) — resolves quarantined tests once bugs are fixed
