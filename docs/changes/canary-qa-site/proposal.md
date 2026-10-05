---
status: proposed
date: 2026-10-05
keywords:
  - qa-dashboard
  - run-contract
  - assessment-contract
  - abstention
  - scope
  - web-components
  - site-feed
  - vercel-dogfood
inputs:
  - docs/ideation/a-qa-site-offered-as-an-add-on-2026-10-05.md (ideas 1 + 7)
---

# Canary QA site — versioned contract and embeddable site kit

## Overview

QA results reach people who do not open code (delivery and client-success staff,
engineering leads) through dashboards that each re-derive the data in their own
shape. Today there are at least three envelopes for this data — the TestTracker
ingest run schema that canary's reporter pushes to, the private
unified-reporting `test-report.json`, and a consumer's internal health-signal
envelope — and **none of them carries a version or names its scope explicitly**.
Each dashboard re-implements the metrics, and the copies drift: in one audited
dashboard, one pass-rate trend returns 0% when nothing ran while the canonical
helper returns "—".

### Goals

1. Publish a **versioned, scope-explicit contract** in two layers:
   - **run** — per-run and per-test records, compatible with the semantics of
     the TestTracker ingest schema canary's reporter already targets;
   - **assessment** — one assessed metric per record, with status in {healthy,
     degraded, critical, not-assessed, observed}, `null` distinct from `0`,
     verification derived rather than asserted, append-only, no composite.
2. Ship a **site kit**: framework-free custom elements that render the contract
   and embed in any host site, plus a **skill family** that builds a feed,
   scaffolds a standalone site, and embeds panels in an existing site.
3. **Dogfood** the kit on the existing Vercel `canary` project, showing canary's
   own suites only.

### Non-goals

- No server, database, auth, or multi-tenancy. The feed is static JSON.
- No composite health number (see D6).
- No organization-specific panels; issue-tracker integrations (release tickets,
  bounce-backs) are out of v1.
- No change to any downstream dashboard. Adopting the run layer is that
  dashboard's own work (it is mid-migration to a REST layer).

### Assumptions

- Runtime: the skills and `validate.mjs` run on Node.js >= 20
  (`agents/skills/package.json` `engines`); the reporter ships in the npm
  package, which requires Node.js >= 22 (`npm/package.json` `engines`).
- Browsers: panels target browsers with native custom elements and shadow DOM;
  no polyfill ships with the kit (D7's zero-dependency rule).
- Feed size: a page loads `site.json` in one fetch and holds it in memory; the
  "last N runs per suite" bound keeps it small.
- Encoding: every contract file is UTF-8 JSON.

### Grounding

- `STRATEGY.md#tracks` — "Quality made legible" (primary) and "Adoption and
  onboarding".
- `STRATEGY.md#our-approach` — "fidelity-labeled evidence over verdicts …
  degrades loudly when the evidence tier drops".
- `STRATEGY.md#not-working-on` — no company-specific content; the contract uses
  generic vocabulary (`scope`, not client/tenant/org).

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Two-layer contract (run + assessment) that **aligns with existing envelopes** rather than defining a new superset.                                                                                                                                                                             | Three envelopes already exist; a fourth unaligned one is the drift problem the ideation's top objection named. Alignment makes adoption a field mapping, not a redesign.                                                                                                                                            |
| D2  | Every record carries an explicit `scope: { id, env }`. Scope is never inferred from a session, token, or "last active" state. `env` is an opaque string.                                                                                                                                       | A consumer integration resolved a handoff to whichever tenant was last open because scope was implicit. Environment vocabularies differ between teams (`demo`/`prod` vs `prod`/`uat`); the contract must not decide whether they are equal.                                                                         |
| D3  | One version convention: a top-level `"contract": "canary.<layer>/<major>"`. Readers refuse an unknown major; a minor change only adds optional fields, so readers tolerate unknown fields — except a producer-supplied `verified` key (D5) and a record of the wrong layer, which are refused. | canary's own outputs mix `schema_version` (int) and `schemaVersion` (int or string) (`ts/src/history/record.ts:19`, `ts/src/analysis/manhunter/assemble.ts:42`, `ts/src/analysis/manhunter/guardian.ts:80`). `ts/src/history/ndjson-store.ts:92-96` already refuses unknown versions — the same rule, made uniform. |
| D4  | Abstention is a first-class value: `null` ≠ `0`; `collected` absent ≠ `[]` ≠ a list; a `not-assessed` assessment requires a `reason` and forbids a `value`.                                                                                                                                    | Independently converged on in canary (`EXIT_ABSTAINED = 3`, `ts/src/core/gate-result.ts`; ADR 0009), in the audited dashboard's canonical pass-rate helper, and in the consumer health-signal work. The contract encodes the one rule all three agree on.                                                           |
| D5  | `verified` is derived from `verified_by` + `verified_at` (both set or both null) and is **refused** if a producer supplies it.                                                                                                                                                                 | A producer asserting its own verification is unauditable; STRATEGY.md names auditable provenance as the precondition for gating.                                                                                                                                                                                    |
| D6  | No composite health score. A `<canary-pillars>` panel shows each factor side by side; a factor with no data abstains with its reason.                                                                                                                                                          | The audited dashboard's weighted 0–10 score was its best-explained output, but the consumer health-signal work rules "pillars, never a composite" and canary's approach is evidence over verdicts. The abstaining-factor behavior is kept; the weighted sum is not. ADR B.                                          |
| D7  | The site kit is framework-free custom elements with zero runtime dependencies, reading a static `site.json`.                                                                                                                                                                                   | Embeds in any host stack (including React), works under a strict CSP, and needs no server — so none of the audited dashboard's tenancy or connection-pool problems are rebuilt.                                                                                                                                     |
| D8  | Build as skills, not engine subcommands.                                                                                                                                                                                                                                                       | Precedent: `docs/changes/594-canary-sweep/provenance.json:89`. `ts/src/history` is at its 1800-LOC ceiling (#1074) and the perf delta rule is unwaivable.                                                                                                                                                           |
| D9  | The dogfood site is **generated by the skill in CI** and deployed from GitHub Actions with `vercel deploy --prebuilt`; the Vercel Git integration stays off.                                                                                                                                   | Canary's run history exists only inside `dogfood.yml` (`.github/workflows/dogfood.yml:430-431`), so a Git-integration build cannot see the feed; re-enabling it would also restore the always-red PR status #769/#787 removed. Generating in CI proves the skill end to end.                                        |
| D10 | Skill family: `canary-starling` (feed), `canary-barda` (standalone site), `canary-vixen` (embed into an existing site).                                                                                                                                                                        | Names are unclaimed in `docs/naming-registry.md` and `docs/roadmap.md`. "Gypsy" was skipped from the roster as a widely recognized slur.                                                                                                                                                                            |
| D11 | The second layer is named **assessment** (`canary.assessment/1`), not "signal".                                                                                                                                                                                                                | A shipped skill is already named `canary-signal` (the QA impact digest), so "signal layer" would collide in conversation and search. `canary-starling` reuses that skill's history and katana-ledger readers instead of copying them.                                                                               |
| D12 | "Never reported" requires a **declared** list of expected suites (`suites[]`, from `canary-site.config.json`). With no declaration, the panel says so instead of guessing.                                                                                                                     | A suite that has never run has no record to appear in; inferring absence from absence is the false-green shape canary exists to catch. Declaring the denominator is the honest fix.                                                                                                                                 |
| D13 | Distinct flaky tests are computed by `canary-starling` over the history window and shipped as a `flaky[]` section, reusing the `canary history flaky --json` window logic.                                                                                                                     | The feed keeps per-test results only on each suite's latest run, so a panel cannot count distinct flakes across runs; the producer has the history, the page does not.                                                                                                                                              |
| D14 | `site-deploy.yml` runs on `workflow_run` after `dogfood.yml` succeeds on `main`, and **refuses to deploy** a feed with zero runs (the job fails loudly; production keeps the last good site).                                                                                                  | Both workflows would otherwise start on the same push, and the deploy would restore the cache before dogfood saved it. A cache miss would publish an all-abstaining site over a good one.                                                                                                                           |
| D15 | Values: `DARK_AFTER_DAYS = 7`; `N = 30` runs per suite; flaky window = the `canary history flaky` default.                                                                                                                                                                                     | 7 days matches the convention both the audited dashboard and the consumer work use; 30 runs keeps `site.json` small enough to load in one fetch.                                                                                                                                                                    |
| D16 | Tests: `happy-dom` (dev dependency of `agents/skills`) for DOM criteria; real Playwright for the strict-CSP criterion.                                                                                                                                                                         | `agents/skills` has no DOM environment today, and happy-dom does not enforce CSP, so criterion 12 needs a real browser.                                                                                                                                                                                             |

## Technical Design

### Run layer — `canary.run/1`

One record per run, or per shard.

```jsonc
{
  "contract": "canary.run/1",
  "scope": { "id": "example-web", "env": "staging" },
  "producer": {
    "name": "canary-test-cli/reporter",
    "version": "8.1.0",
    "channel": "ci",
  },
  "run": {
    "id": "123456-1-s2of4", // shard-aware (#1148)
    "suite": "web-e2e",
    "branch": "main",
    "commit_sha": "…",
    "started_at": "…",
    "finished_at": "…",
    "ci_url": "…",
    "status": "passed | failed | cancelled",
    "shard": { "index": 2, "total": 4 }, // or null
  },
  "totals": {
    "passed": 0,
    "failed": 0,
    "flaky": 0,
    "skipped": 0,
    "timed_out": 0,
    "interrupted": 0,
    "total": 0,
  }, // #1149
  "results": [
    {
      "title": "…",
      "file": "tests/x.spec.ts",
      "status": "passed | failed | flaky | skipped | timed_out | interrupted",
      "duration_ms": 0,
      "retries": 0,
      "area": null,
      "tags": [],
      "error": { "message": "…", "stack": "…" }, // or null
    },
  ],
  "collected": null, // null = not reported · [] = none collected · [...] = list (#1150)
}
```

- `file` is repo-relative (ADR 0029's join key).
- `results` is a list or `null`: `null` = per-test results not carried in this
  record, `[]` = zero tests. When `results` is a list, `totals.total` must equal
  `results.length`; a mismatch is a validation error, not a warning.
- `run.status` has no `flaky` value, although the ingest reporter sends one
  today. A run whose only non-passes are recovered flakes is `passed`, with its
  flakiness carried in `totals.flaky`; a run that did not complete
  (`interrupted`, `timedout`) is `cancelled`. The existing ingest payload is
  unchanged.

### Assessment layer — `canary.assessment/1`

Append-only. Identity key: `scope.id + scope.env + source + metric`; consumers
read "latest per key".

```jsonc
{
  "contract": "canary.assessment/1",
  "scope": { "id": "canary", "env": "ci" },
  "source": "canary.ci-ready",
  "metric": "flakiness",
  "status": "healthy | degraded | critical | not-assessed | observed",
  "value": 0.012, // null iff not-assessed; observed requires a value
  "unit": "ratio",
  "reason": null, // required iff not-assessed
  "evidence": {
    "tier": "coverage-verified | graph-verified | heuristic", // or null
    "denominator": 412, // or null
  },
  "observed_at": "…", // when the check ran, not when stored
  "sources": ["history-v2.jsonl@<sha>"],
  "verified_by": null,
  "verified_at": null, // both set or both null; `verified` is derived
}
```

### Site feed — `canary.site/1`

`site.json` is the single file a page loads.

```jsonc
{
  "contract": "canary.site/1",
  "generated_at": "…",
  "scopes": [{ "id": "canary", "env": "ci" }],
  "suites": [
    { "scope": { "id": "canary", "env": "ci" }, "suite": "ts-engine" },
  ], // declared expected suites (D12); null = none declared
  "runs": [], // last 30 canary.run/1 per suite; per-test results only on each suite's latest run
  "flaky": [
    {
      "scope": { "id": "canary", "env": "ci" },
      "suite": "ts-engine",
      "title": "…",
      "file": "…",
      "flaky_runs": 3,
      "window_runs": 30,
    },
  ], // distinct tests (D13)
  "assessments": [], // latest canary.assessment/1 per identity key
  "register": [], // skipped/removed tests from the canary-katana ledger: reason, age (no author)
}
```

Every `scope` in the feed, including on `suites[]`, `flaky[]` and `register[]`,
is the full `{ id, env }` object (D2); a bare string is refused. A `register[]`
row carries `scope`, `title`, `file`, `kind`, `reason`, `recorded_at`, `commit`,
`cause` and `issue`. Author identity is deliberately excluded from a public
feed: a `who` or `author` key on a register row is refused.

### Panels (v1)

| Element                     | Shows                                                                                    | Reads            |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| `<canary-pipeline-health>`  | Per suite: green / red / **dark** (no run within `DARK_AFTER_DAYS`) / **never reported** | `runs`, `suites` |
| `<canary-pass-rate>`        | Trend; empty denominator renders "—", never 0; never rounds up to 100%                   | `runs`           |
| `<canary-failures-by-area>` | Failures by area; not-run and quarantined separated                                      | latest results   |
| `<canary-flaky>`            | Distinct flaky tests (not occurrences), with flaky runs / window runs                    | `flaky`          |
| `<canary-pillars>`          | ci-ready checks with evidence tier; abstaining pillars state their reason                | `assessments`    |
| `<canary-register>`         | Skipped/deleted tests as visible debt: reason, age                                       | `register`       |

Every abstention renders as text **and** is announced through a live region.
`DARK_AFTER_DAYS` is defined once and imported by every panel that needs it.
Design tokens live in one `tokens.css`; panels use only `var(--…)`.

### File layout

```text
docs/specs/canary-run-contract.md
docs/specs/canary-assessment-contract.md
docs/specs/canary-site-feed-contract.md
agents/skills/lib/contracts/run.v1.schema.json
agents/skills/lib/contracts/assessment.v1.schema.json
agents/skills/lib/contracts/site.v1.schema.json
agents/skills/lib/contracts/validate.mjs          # zero-dependency validator (API + CLI)
agents/skills/lib/contracts/schema-check.mjs      # JSON Schema keyword-subset interpreter
agents/skills/lib/contracts/schema-problems.mjs   # load-time audit: refuses any unenforced schema
agents/skills/lib/contracts/rules.mjs             # named cross-field rules
agents/skills/lib/site-kit/canary-site.js         # registers all elements
agents/skills/lib/site-kit/panels/*.js
agents/skills/lib/site-kit/tokens.css
agents/skills/claude-code/canary-starling/        # feed: compose + validate site.json
agents/skills/claude-code/canary-barda/           # build: scaffold a standalone site, add panels, theme
agents/skills/claude-code/canary-vixen/           # embed: snippet + host token mapping
npm/src/reporters/testtracker.ts                  # emits canary.run/1 (#1148, #1149, #1150)
.github/workflows/site-deploy.yml                 # main only
```

The site kit ships inside the npm package (`agents/` is already in
`npm/package.json` `files`) and is therefore loadable from a public npm CDN at a
pinned version.

### Dogfood pipeline

```text
dogfood.yml succeeds on main ─► site-deploy.yml (workflow_run, D14)
   restore history cache (as dogfood.yml) ─► canary-starling build → site.json
   ─► validate.mjs (refuse on any error)
   ─► refuse if site.json has zero runs (fail loudly; production untouched)
   ─► canary-barda build → ./site-out
   ─► scripts/check_removed_symbols.mjs over ./site-out
        (fails on any hit; reports files checked — 0 checked fails the job)
   ─► vercel deploy --prebuilt --prod   (GitHub environment: Production)
```

The feed is built from canary's own suites only.

## Integration Points

### Entry Points

- Skills: `canary-starling`, `canary-barda`, `canary-vixen` (each
  `scripts/cli.mjs`, run through `canary skills run <name>`).
- Library modules: `agents/skills/lib/contracts/`,
  `agents/skills/lib/site-kit/`.
- Reporter: `canary-test-cli/reporter` gains `canary.run/1` emission.
- Workflow: `.github/workflows/site-deploy.yml`.

### Registrations Required

- `docs/naming-registry.md`: reserve, then ship, `canary-starling`,
  `canary-barda`, `canary-vixen` (`ts/test/bop-name-registry.test.ts`).
- `harness.config.json`: each `cli.mjs` in **both** `entryPoints` arrays
  (entropy and performance). Harness layers cover `ts/src` only (`SOURCE_ROOT`
  in `ts/test/harness-config-denominator.test.ts`), so `lib/contracts/` and
  `lib/site-kit/` need no layer assignment to keep that test green.
- `agents/skills/package.json` `format:check` globs;
  `agents/skills/vitest.config.ts` coverage include.
- Each `cli.mjs` exports `CLI_SPEC`
  (`agents/skills/test/skill-cli-conformance.test.ts`).
- `.github/required-checks.json`: classify `site-deploy.yml`; update the Vercel
  `externalStatuses` entry's `reason` (it stays `expected: none`, so
  `ts/test/workflow-false-green.test.ts:398-410` still holds).
- Repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — a human
  step.
- `docs/roadmap.md`: a row for this feature.

### Documentation Updates

- `AGENTS.md`: skills section (three skills, the contract library).
- `docs/wiki/QA-Site.md` (new): building a site, embedding panels, the contract.
- `docs/wiki/TestTracker-Reporter.md`: `canary.run/1` emission, shard-aware run
  ids, status mapping.
- `README.md`: feature list.

### Architectural Decisions

- **ADR A — a versioned two-layer QA data contract** (D1–D5). It is a contract
  other teams' systems will adopt, so its versioning and abstention rules need a
  durable record outside this spec.
- **ADR B — pillars, no composite health score** (D6). It overrides a "keep"
  verdict from the dashboard audit and will be challenged; the reasoning should
  be findable.

### Knowledge Impact

- Concepts: _abstention as a value_ (null ≠ 0; absent ≠ empty), _scope_
  (explicit `id` + `env`), _assessment identity key_, _declared expected
  suites_, _pillars over composite_.
- Relationship: `canary.run/1` is the producer-side contract for the TestTracker
  ingest reporter (#603).

## Success Criteria

1. When a record has no `contract` field or an unknown major version, the
   validator shall refuse it with an error naming the field.
2. If a assessment is `not-assessed`, then the validator shall refuse it when it
   carries a `value` or lacks a `reason`; if a assessment is `healthy`,
   `degraded`, `critical` or `observed`, then it shall refuse it when `value` is
   null.
3. If a producer supplies `verified`, then the validator shall refuse the
   record.
4. When `results` is a list and `totals.total` differs from `results.length`,
   the validator shall refuse the run record.
5. When two shards of one workflow run push the same suite, the reporter shall
   emit distinct `run.id` values (#1148).
6. When Playwright reports `timedOut` or `interrupted`, the reporter shall emit
   `timed_out` or `interrupted` respectively (#1149).
7. When the reporter runs, it shall emit `collected` as the full collected test
   list (#1150); if the collected list is unavailable, it shall emit `null`,
   never `[]` (D4).
8. When an input to `canary-starling` is absent (for example no inventory), the
   corresponding assessment shall be `not-assessed` with a reason — never
   omitted and never `0`. Verified with a planted absence.
9. When a pass-rate denominator is empty, `<canary-pass-rate>` shall render "—";
   a 99.6% rate shall never render as 100%.
10. When a suite has no run within `DARK_AFTER_DAYS`, `<canary-pipeline-health>`
    shall render it dark; a declared suite with no runs shall render
    never-reported; when `suites` is null, the panel shall state that no
    expected suites are declared rather than render never-reported (D12).
11. When any panel abstains, the abstention shall be announced through a live
    region (asserted in a DOM test).
12. When `canary-vixen`'s embed snippet is placed in a host page served with a
    strict CSP (a `script-src` that allows neither `'unsafe-inline'` nor
    `'unsafe-eval'`), the panels shall render and the page shall log no CSP
    violation.
13. If `check_removed_symbols.mjs` matches in the built site, then
    `site-deploy.yml` shall fail without deploying; if it checked zero files,
    the job shall fail.
14. When a pull request is opened, no Vercel commit status shall appear.
15. Build, typecheck, format check and tests pass in `ts/` and `agents/skills/`;
    entropy, perf and arch ratchets pass without raising `maxFindings` or a
    baseline.
16. When a record has no `scope`, or a `scope` missing `id` or `env`, the
    validator shall refuse it with an error naming the field (D2).
17. If a assessment sets exactly one of `verified_by` and `verified_at`, then
    the validator shall refuse it (D5).
18. If the validator's input is not parseable JSON, then it shall refuse it — a
    parse failure is never a pass.
19. When two assessments share an identity key
    (`scope.id + scope.env + source + metric`), `canary-starling` shall write
    only the one with the latest `observed_at` to `site.json` `assessments`.
20. When a assessment is `not-assessed`, `<canary-pillars>` shall render its
    `reason` as text; no panel shall render a composite score (D6).
21. When `canary-barda build` runs over a `site.json` that passes validation,
    the output directory shall contain a static page that renders each of the
    six v1 panels.
22. When `site-deploy.yml` builds the dogfood feed, every `scopes[].id` in the
    deployed `site.json` shall be canary's own (Goal 3).
23. When one test flakes in several runs of the window, `<canary-flaky>` shall
    count it once and show its flaky-runs / window-runs ratio (D13).
24. If the dogfood feed has zero runs, then `site-deploy.yml` shall fail without
    deploying (D14).

## Implementation Order

One PR per phase, merged serially and re-measured after each merge.

1. **Contract** — `docs/specs/` contract docs, three JSON Schemas,
   `validate.mjs`, ADR A. (Criteria 1–4, 16–18.)
2. **Producers** — reporter emits `canary.run/1` with the #1148/#1149/#1150
   fixes; `canary-starling`. (Criteria 5–8, 19.)
3. **Site kit** — `tokens.css`, six panels, `canary-barda`, ADR B. (Criteria
   9–11, 20–21, 23.)
4. **Embed** — `canary-vixen` and the strict-CSP host fixture. (Criterion 12.)
5. **Dogfood** — `site-deploy.yml`, secrets, `docs/wiki/QA-Site.md`. (Criteria
   13–14, 22, 24.) **Precondition:** confirm whether a CLI
   `vercel deploy --prebuilt --prod` against the still-connected project posts a
   `Vercel` status on `main` commits. If it does, change the `externalStatuses`
   entry to a main-only expectation and update
   `ts/test/workflow-false-green.test.ts` in the same PR, rather than leaving
   `expected: none` untrue.

Criterion 15 is a gate on every phase, not a phase of its own.
