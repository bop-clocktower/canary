---
name: TestTracker Ingest Reporter (interim)
status: draft
type: dx
owner: brianna.stevenski@example.com
created: 2026-07-24
related_decisions: []
supersedes_decisions: []
introduces_adrs: []
---

# TestTracker Ingest Reporter (interim)

**Keywords:** testtracker, qa-intelligence-dashboard, ingest, playwright,
reporter, canary-test-cli, canary-publish

## Overview

Ship a single, config-driven Playwright reporter from the `canary-test-cli` npm
package that pushes completed test runs to the TestTracker (QA dashboard
Dashboard) ingest API. This **consolidates** the currently
copy-pasted-and-drifted `reporters/testtracker-reporter.ts` files (one each in
`consumer-a-api` and `consumer-a-web`) into one shared, versioned reporter, and
onboards Consumer B (both Playwright suites) onto it.

This is the **interim** delivery (Path 3 / hybrid). It is the explicit precursor
to the spec-pure `canary publish` command described in
`canary-internal/docs/specs/unified-reporting.md`, whose "QA dashboard Dashboard
live integration" is a roadmap item **blocked on Phase 2a** (`canary report`,
not yet shipped). See §Convergence.

## Goals

- One reporter, shipped from `canary-test-cli` as the `canary-test-cli/reporter`
  package subpath export (consumers already carry `canary-test-cli` in devDeps).
- Config-driven: `suite`, `test_file` prefix, and environment mapping come from
  constructor options + env — no hardcoded per-repo values.
- Fix two latent bugs in the reference copies:
  - hard `dotenv` import can crash suite startup → make dotenv optional;
  - `canary_run_id = sha7-<randomUUID>` is not stable, so ingest idempotency on
    `(canary_run_id, suite)` never dedupes → use `GITHUB_RUN_ID` (+
    `GITHUB_RUN_ATTEMPT`) with a local fallback.
- Adopt in Consumer B for both suites (`apps/api-contract` → `consumer-b-api`,
  `apps/web-e2e` → `consumer-b-web`; the sharded web-e2e nightly pushes once at
  the `merge-reports` step).
- Migrate `consumer-a-api` and `consumer-a-web` onto it; delete their local
  copies.

## Non-goals

- Building `canary report` / Phase 2a (separate, prior roadmap item).
- The spec-pure `canary publish` bound to the frozen `test-report.json`
  envelope.
- Non-Playwright suites (Vitest / Newman / pytest) — Playwright only for the
  interim.
- Mobile suites — Consumer B has none.

## Ingest contract (target)

`POST {TESTTRACKER_URL}/api/ingest/runs`, `Authorization: Bearer <tt_ token>`,
idempotent on `(canary_run_id, suite)`. Body = `CreateAutomatedRunInput`:

```text
canary_run_id, suite, status, started_at,
[finished_at, branch, commit_sha, workflow, environment],
totals { passed, failed, flaky, skipped, total },
results[] { full_title, test_file, status,
            [duration_ms, error_message, error_stack, retries, tags[], area] }
```

Response:
`{ id, canary_run_id, suite, status, ingested_at, result_count, duplicate }`.

## Impedance-mismatch note

TestTracker ingest wants **per-test rows**; the frozen `test-report.json`
envelope (Phase 2a) is **aggregate-first** (summary + area_health + failures +
quarantined). The interim reporter sidesteps this by reading Playwright's own
`onTestEnd` per-test data directly. When `canary publish` lands, it must either
extend the frozen envelope with a per-test array or push from raw Playwright
JSON.

## Convergence (interim → spec-pure)

The reporter is documented as the interim vehicle. When Phase 2a ships
`canary report`, the follow-up `canary publish` command supersedes this
reporter; consumers move from `reporter: canary-test-cli/reporter` in
`playwright.config` to a post-run `canary publish` CI step, and this reporter is
deprecated (kept for one minor for migration, then removed). This proposal links
that follow-up.

## Integration Points

- **Entry Points:** new package subpath export `canary-test-cli/reporter`.
- **Registrations Required:** `@playwright/test` added as an _optional_ peer
  dependency; `dist/reporters/**` added to published `files`.
- **Documentation Updates:** canary docs — adoption guide + convergence note;
  Consumer B + consumer-a repo READMEs/AGENTS as touched.
- **Architectural Decisions:** none new (interim under existing
  unified-reporting spec).
- **Knowledge Impact:** none.
