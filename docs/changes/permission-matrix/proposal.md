---
name: Permission-matrix tests
status: approved
type: generator
owner: ahhrealmonster
created: 2026-09-10
related_decisions:
  - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
supersedes_decisions: []
introduces_adrs: []
---

# Permission-matrix tests (#857)

**Keywords:** authorization, multi-tenant, RBAC, tenant isolation, playwright,
codegen, existence oracle, abstention

## Overview

The most damaging multi-tenant finding is one tenant reading another's data, or
a role boundary that exists only in the UI. Ordinary suites miss both because
they are written from the UI, where the forbidden action is never offered.

`canary permission-matrix` reads a **human-declared** allow/deny grid of roles ×
endpoints, expands it across every acting tenant × target tenant, and emits
Playwright API tests that hit the server directly.

## Decisions

| Decision          | Choice                                  | Why                                                                                                       |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Declaration shape | **Grid** (one cell per role × endpoint) | A missing cell is visible to the author. A `default: deny` rule would hide the cells nobody thought about |
| Inference         | Never                                   | Inferring expectations from current behaviour bakes today's bugs in as "expected"                         |
| Undeclared cells  | Reported `UNDECLARED`, exit 3, `fixme`  | A cell with no expectation cannot be verified; it must be countable, never silently skipped (ADR 0009)    |
| Runner            | Playwright `request` context            | Already in the registry; bypasses the UI by construction                                                  |

## The model

```yaml
roles: [family, staff, examiner]
tenants: [county-a, county-b]
endpoints:
  GET /persons/{id}:
    family: own-tenant
    staff: own-tenant
    examiner: own-tenant
  POST /persons/{id}/deceased:
    family: deny
    staff: deny
    examiner: own-tenant
```

Cell values:

- `allow`: allowed for every acting × target tenant pair (use sparingly)
- `own-tenant`: allowed when acting tenant = target tenant, denied across
- `deny`: denied everywhere

Credentials and fixtures come from the environment, never the model:
`CANARY_TOKEN_<ROLE>_<TENANT>` (bearer token) and `CANARY_ID_<TENANT>` (a
synthetic record owned by that tenant). Names are upper-cased, with non
alphanumerics mapped to `_`.

Generated assertions: allowed → status < 400; denied → 401, 403 or 404. Paths
are relative, so the consuming Playwright config sets `use.baseURL`.

## Where it lives

- [`ts/src/core/permission-matrix.ts`](../../../ts/src/core/permission-matrix.ts):
  pure parse, expand and render. No I/O.
- [`ts/src/permission-matrix-cli.ts`](../../../ts/src/permission-matrix-cli.ts):
  the `canary permission-matrix` command. Reads the model, writes the suite, and
  exits 3 on undeclared cells.

## Phase 2 (follow-up): existence-oracle probe

For lookup endpoints, compare responses for a known-present vs known-absent id
under each role and flag distinguishable status, body shape or timing.

## Non-goals

- Not a pen test, and no replacement for one. It stops a fixed authz boundary
  regressing between pen tests; a pen-test finding becomes a new cell.
- No production data. Tenants and records are synthetic fixtures.

## Success criteria

- A 3-role × 2-endpoint × 2-tenant model expands to 24 cells, cross-tenant cells
  denied under `own-tenant`.
- A missing cell or an unknown value is reported by name and exits 3.
- The generated file is valid Playwright and names each cell in its title.
