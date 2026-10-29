---
status: proposed
date: 2026-10-28
keywords:
  - tool-review
  - qa-process
  - personas
  - job-catalog
  - result-surface-qualities
  - friction
  - playwright-walk
  - abstention
  - rca-traceability
inputs:
  - brainstorming session 2026-10-28 (decisions D1–D12 below)
  - docs/changes/canary-qa-site/proposal.md (dogfood target, contract family)
---

# canary-blackalice — review a QA tool from the seats of the people who use it

## Overview

`canary-blackalice` answers one question about a QA tool — a test tracker, a
test-case manager, a results dashboard — for each person who touches it: **does
this tool give you what you need, or does it get in your way?** Testers, SDETs
and QA leads do the testing in the tool; developers, PMs, owners and external
client viewers read what it reports. A tool can be complete for the first group
and unreadable for the second, and neither failure shows up in the tool's own
test suite.

The skill builds a capability map of the tool from its code, routes and docs,
walks the highest-risk jobs live in a browser as the persona who owns each one,
checks every result surface it meets against four reporting qualities, and
writes a findings report whose first lines say how much of the tool it actually
examined. Reports are committed and diffed run over run; findings become tracker
issues only after a human ticks them.

[evidence] `STRATEGY.md#who-its-for` — the secondary persona is staff "who need
to answer 'is this client's platform healthy and well-covered?' without reading
code"; this skill reviews whether a tool lets them. `STRATEGY.md#our-approach` —
"degrades loudly when the evidence tier drops rather than silently guessing";
the ledger (D9) applies that to the review itself.

### Goals

1. **A generic, versioned QA job catalog** — ~30–50 jobs across 6 personas
   (manual tester, SDET, QA lead, developer, PM/owner, external client viewer)
   and 6 process stages (plan → design → execute → defects → triage → report),
   with a per-tool overlay that adds tool-specific jobs and disables ones that
   do not apply, each disable with a reason.
2. **Four result-surface qualities**, checked on every surface that shows a
   result: Q1 plain language, Q2 loud states (failure, all-green and
   not-run/unknown each unmistakable), Q3 glance → drill-down, Q4 tracing and
   history sufficient for root-cause analysis.
3. **An honest denominator** — every job and surface ends a run in exactly one
   ledger state (walked / mapped / not-assessed / not-applicable), and a report
   that cannot account for all of them does not build.
4. **Comparable runs** — reports committed as `docs/reviews/<tool>-<date>.md`
   plus a `canary.tool-review/1` JSON record, diffed against the previous
   review.
5. **Dogfood on two targets** — the canary QA site (after its demo-scope
   build-out, sub-project 2) and TestTracker (overlay and report in its own
   repository).
6. **The CLI's own guarantees** — the deterministic core never computes a
   composite score, never calls a tracker API, and never imports an LLM SDK, and
   each guarantee is enforced by a test rather than by convention.

### Non-goals

- Not a review of test **data** (runs, flakiness, coverage) — `canary-ci-ready`
  and the QA site panels own that.
- No composite tool score (D8).
- No generated Playwright journey specs in v1. Mechanical friction measures (axe
  violations, step counts, timings) may be added later as optional evidence
  fields on a walked job without changing the contract's required core.
- No automatic filing of issues and no change to the reviewed tool.

### Assumptions

- Runtime: skill scripts run on Node.js >= 20 (`agents/skills/package.json`
  `engines`), like `canary-starling` and `canary-barda`.
- The skills tree stays dependency-free (ADR 0035), so every catalog, quality
  and overlay file is JSON — there is no YAML parser available to it.
- The walk phase requires a browser driver available to the agent (the
  Playwright MCP, configured in the repo's `.mcp.json` as `@playwright/mcp`).
  Without one, every job is `mapped` or `not-assessed` and the run records a
  run-level abstention (`not_assessed`: "walk skipped: no browser driver").
- The reviewed tool is reachable at a URL with test credentials and enough seed
  data for the walked jobs. Missing seed data is a `not-assessed` reason, never
  a silent skip.

## Decisions

| #   | Decision                                                                                                                                                                                 | Rationale                                                                                                                                                                                                                                                   | Rejected                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1  | Review the **tool itself** from its users' seats, not the test data in it                                                                                                                | The question is whether the tool helps or hinders the QA process; data review is already covered by `canary-ci-ready` and the site panels                                                                                                                   | run review; catalog review; release readiness  |
| D2  | **Map, then walk** — a static capability map from code, routes and docs, then a live walk of the 5–8 highest-risk jobs                                                                   | The map finds what is _missing_; the walk finds what _hurts_. A walk alone cannot see an absent capability; a read alone cannot feel friction                                                                                                               | walk only; read only                           |
| D3  | A **built-in generic job catalog** plus a **tool-owned overlay file** merged by this skill's CLI                                                                                         | "Everything a tester needs" must be defined independently of the tool — a tool's docs never list the job it forgot — and a fixed catalog makes runs comparable                                                                                              | jobs derived from the tool's docs; interview   |
| D4  | **Six personas**, including the external client viewer                                                                                                                                   | Results travel beyond testers; the external viewer adds scoped-visibility and no-internal-leak jobs                                                                                                                                                         | testers only                                   |
| D5  | **Q1–Q4 are a separate checklist applied to every result surface**, not jobs                                                                                                             | They are properties of surfaces, not tasks; as jobs they would duplicate across personas and miss surfaces no walked job visits                                                                                                                             | qualities as jobs                              |
| D6  | **Q2 has three loud states** — not-run/unknown is never rendered as green                                                                                                                | Applies ADR 0035's abstention rule (decision 4: `null` ≠ `0`; `not-assessed` carries a reason) and ADR 0036's rule that an abstaining factor shows its reason: a dashboard that renders "nothing ran" as green is the most misleading surface a PM can read | two states                                     |
| D7  | Output is a **findings report** (blocker / friction / polish) with evidence and a plain-language cost, committed to the repo; **issues filed only for findings a human ticks**           | Findings carry judgment; a human checks them before they become tracker items. Committing makes reviews diffable                                                                                                                                            | auto-file; scorecard grid                      |
| D8  | **No composite tool score**                                                                                                                                                              | A roll-up hides the persona that was failed; consistent with the QA site spec's D6                                                                                                                                                                          | score out of 10                                |
| D9  | **Deterministic core + agent judgment** — an LLM-free CLI owns catalog/overlay validation, the coverage ledger, the report schema and the diff; the agent owns mapping, walking, judging | The review is held to the rule it checks others against: say how you know and abstain loudly. The CLI refuses a report that overclaims. Mirrors the strategy's Tier-0 bet                                                                                   | agent-only skill; generated journey specs      |
| D10 | The canary QA site build-out is a **separate sub-project**: deploy plus demo scope first, then work driven by this skill's findings                                                      | Gives the review realistic data without pre-building the answers it should find                                                                                                                                                                             | build the showcase first; review the bare site |
| D11 | **Generic concepts only in public canary**; tool-specific overlays, internal routes and paths, screenshots and the review report itself live in the reviewed tool's repository           | Public-repo leak risk (#942; the proprietary denylist). A tool's _name_ may already be public — TestTracker is a deliberate public integration — but what a review sees inside it is not                                                                    | keep tool overlays or reports in canary        |
| D12 | Name: **`canary-blackalice`** — checked unclaimed in `docs/naming-registry.md`, `docs/roadmap.md` and the tracker (issues and PRs) on 2026-10-28                                         | Black Alice borrows other heroes' powers; the skill borrows each persona's seat in turn                                                                                                                                                                     | catwoman; hawkgirl                             |

Note on D3: the overlay is **not** the org skill-overlay mechanism in
`ts/src/core/overlays.ts` (#333), which resolves cloned skill packs under
`~/.canary/overlays/`. The tool overlay is a single data file this skill's CLI
merges.

## Technical Design

### File layout

```text
agents/skills/claude-code/canary-blackalice/
  SKILL.md                      # agent layer: map → walk → judge → report → confirm
  catalog/jobs.v1.json          # generic job catalog (public; generic terms only)
  catalog/qualities.v1.json     # Q1–Q4 definitions and their pass/fail tells
  scripts/cli.mjs               # deterministic core; imports no LLM SDK
  scripts/catalog.mjs           # catalog + overlay load, merge, validation
  scripts/ledger.mjs            # plan / record / summary
  scripts/report.mjs            # build, render Markdown
  scripts/diff.mjs              # finding and ledger deltas between two reports
agents/skills/lib/contracts/
  tool-review.v1.schema.json    # the contract's schema (ADR 0035 subset)
  tool-review.mjs               # its own validator entry point and named rules, like critical-areas.mjs
docs/specs/canary-tool-review-contract.md
```

`tool-review.mjs` is a standalone entry point, following `critical-areas.mjs`.
The shared `document.mjs` does not route it: its `CONTRACT_RE` admits no hyphen
and its `LAYERS` list is fixed to run/assessment/site, so routing
`canary.tool-review/1` through it would mean widening a validator three other
contracts depend on. Its dispatch is unchanged; it gains only a refusal message
that points `canary.tool-review/1` to `tool-review.mjs`
([ADR 0045](../../knowledge/decisions/0045-tool-review-ledger-first-contract.md)).

### Job catalog — `catalog/jobs.v1.json`

```jsonc
[
  {
    "id": "execute.record-result-per-platform",
    "persona": "manual-tester", // manual-tester | sdet | qa-lead | developer | pm-owner | external-viewer
    "stage": "execute", // plan | design | execute | defects | triage | report
    "job": "Record a result for each platform without leaving the run",
    "done_when": [
      // observable, so "walked" has a definite answer
      "a result is saved per platform from one view",
      "the previous result for the case is visible while recording",
    ],
    "risk": "high", // high | medium | low — orders walk candidates
  },
]
```

Example jobs for the result readers: `triage.find-when-it-started-failing`
(developer, RCA), `report.read-release-status-at-a-glance` (PM/owner),
`report.see-only-my-results` and `report.understand-without-internal-terms`
(external viewer).

### Qualities — `catalog/qualities.v1.json`

| Id  | Quality             | A surface fails when                                                                                                                                                           |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Plain language      | Its default view shows stack traces, enum identifiers, internal codes or jargon a non-engineer cannot read; detail is acceptable one drill-down deeper                         |
| Q2  | Loud states         | A failure, an all-green result, or a not-run/unknown result is not unmistakable at a glance — and fails outright if not-run/unknown renders as green or as an empty/zero state |
| Q3  | Glance → drill-down | The headline answer takes more than a glance, or summary → suite → test → evidence is not reachable in a few steps                                                             |
| Q4  | Trace & history     | A result does not link to its run, build, environment and prior results, or history is not retained long enough to answer "when did this start failing and what changed?"      |

### Tool overlay — `.canary/blackalice.overlay.json` (in the reviewed tool's repo)

```jsonc
{
  "tool": {
    "name": "example-tracker",
    "url": "https://staging.example.test",
    "auth": { "user": "env:REVIEW_USER", "secret": "env:REVIEW_SECRET" },
  },
  "add": [
    // tool-specific jobs, same shape as the catalog
    {
      "id": "execute.carryover-red-flags-visible",
      "persona": "manual-tester",
      "stage": "execute",
      "job": "See which cases failed last run when a new run opens",
      "done_when": ["flagged cases are distinguishable before any is opened"],
      "risk": "high",
    },
  ],
  "disable": [
    {
      "id": "plan.import-from-external-tracker",
      "reason": "the tool has no external tracker",
    },
  ],
}
```

Credentials are referenced only by environment-variable name, user and secret
separately; a literal value in either field is refused. A `disable` without a
reason, or naming an unknown id, is a validation error. Disabled jobs report as
**not-applicable**, never as **not-assessed**.

### Coverage ledger

Every merged job, and every result surface the map phase discovers, ends the run
in exactly one state:

| State            | Meaning                        | Required                  |
| ---------------- | ------------------------------ | ------------------------- |
| `walked`         | Driven live in the browser     | ≥1 snapshot or screenshot |
| `mapped`         | Judged from code and docs only | ≥1 `file:line`            |
| `not-assessed`   | Not examined this run          | reason                    |
| `not-applicable` | Disabled by the overlay        | the overlay's reason      |

`plan` writes every **job** row as `pending`. Result surfaces are not known
until MAP, so `record --surface <path>` creates a `kind: surface` row directly
in its final state. Apart from that, `record` is the only way a row leaves
`pending`.

A ledger with zero `walked` rows is an **abstention**, not a review with no
findings. Following the skill-CLI convention in
`agents/skills/test/gate-conformance.test.ts`, `report build` stays advisory by
default — it prints the abstention line first, writes **no** report file, and
exits 0 — and exits 3 only under `--strict`.

### Report — `canary.tool-review/1`

```jsonc
{
  "contract": "canary.tool-review/1",
  "tool": { "name": "…", "commit_sha": "…", "url": "…" },
  "reviewed_at": "…",
  "catalog_version": "jobs.v1",
  "overlay_sha": "…", // null when no overlay
  "ledger": [
    {
      "id": "…",
      "kind": "job | surface",
      "state": "walked",
      "reason": null,
      "evidence": [],
    },
  ],
  "findings": [
    {
      "id": "f-003",
      "severity": "blocker | friction | polish",
      "persona": "pm-owner",
      "job": null, // job id, or null
      "quality": "Q2", // Q1–Q4, or null; at least one of job/quality is set, both may be
      "surface": "/dashboard",
      "what_happened": "A suite with no runs this week shows a green tick",
      "cost": "A PM reads 'all good' for a suite nobody ran", // plain language, required
      "evidence": [{ "kind": "screenshot | snapshot | file", "ref": "…" }], // ≥1
      "file_candidate": true, // the default selection for `file --pick`
    },
  ],
  "not_assessed": [], // run-level abstentions; required, [] means none
}
```

`not_assessed` holds **run-level** abstentions only — a phase or capability the
run could not exercise at all ("walk skipped: no browser driver", "overlay auth
env var unset"). Per-row `not-assessed` states stay in `ledger`; the two never
duplicate each other.

The schema stays inside ADR 0035's subset (no `oneOf`, no
`additionalProperties`), so five constraints are named rules in
`tool-review.mjs`, which keeps its own rules as `critical-areas.mjs` does
([ADR 0045](../../knowledge/decisions/0045-tool-review-ledger-first-contract.md)):

- **`jobOrQuality`** — a finding with both `job` and `quality` null is refused;
  setting both is allowed.
- **`noCompositeScore`** — the keys `score`, `overall`, `composite` and `rating`
  are refused on the report and on every finding.
- **`evidenceRequired`** — a finding with `evidence: []` is refused.
- **`ledgerCompanion`** — each ledger state carries its companion from the
  ledger table: a `walked` row a snapshot or screenshot, a `mapped` row a file,
  a `not-assessed` or `not-applicable` row a reason.
- **`idsUnique`** — no two findings, and no two ledger rows, share an `id`.

`reviewed_at` also gets the shared `real-dates` check that every other canary
timestamp has.

The Markdown render opens with the ledger counts ("walked 7 · mapped 21 · not
assessed 12 · not applicable 3") and any run-level abstentions before any
finding, then findings by severity, each with its persona, plain-language cost
and evidence links.

### CLI — `scripts/cli.mjs`

Exit codes follow the contract validator: **0** ok, **1** refused (invalid
input, failed validation), **2** usage error, **3** abstention — only under
`--strict`.

| Command                                                                   | Behavior                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog check [--overlay <f>]`                                           | Validate catalog + overlay; print the merged job count per persona and stage                                                                                                                                              |
| `plan --overlay <f> --out <ledger>`                                       | Write the ledger with every job row `pending`; rank walk candidates by `risk`                                                                                                                                             |
| `record <ledger> <id> <state> [--surface <path>] [--reason] [--evidence]` | Move one row out of `pending`, or create a `kind: surface` row with `--surface`; refuse a missing reason or evidence                                                                                                      |
| `report build <ledger> <findings> --out <dir> [--strict]`                 | Assemble, validate and render; refuse any `pending` row, any finding breaking the schema or a named rule, or a missing `not_assessed`. On 0 walked: print the abstention line, write no file, exit 0 (3 under `--strict`) |
| `diff <prev.json> <next.json>`                                            | Classify findings as new / resolved / still open; print the ledger state deltas                                                                                                                                           |
| `file [--pick f-001,f-004] <report.json>`                                 | Print issue bodies for the picked findings; with no `--pick`, the findings marked `file_candidate`. Never calls a tracker API                                                                                             |

### Agent layer — `SKILL.md`

1. **MAP** — read routes, navigation, docs and schemas; enumerate result
   surfaces (`record --surface`); `record` each job `mapped` or `not-assessed`.
2. **WALK** — take the top 5–8 candidates from `plan`; walk each as its persona
   through the Playwright MCP; check Q1–Q4 on every result surface visited;
   `record` each `walked` with its evidence.
3. **JUDGE** — write each finding's severity and plain-language cost.
4. **REPORT** — `report build`, then `diff` against the previous review if one
   exists.
5. **CONFIRM** — present the findings with the filing checklist (pre-ticked from
   `file_candidate`); file only what the human ticks; stop.

## Integration Points

### Entry Points

- New skill `agents/skills/claude-code/canary-blackalice/` (`SKILL.md`,
  `catalog/`, `scripts/cli.mjs`).
- New contract `canary.tool-review/1`: schema
  `agents/skills/lib/contracts/tool-review.v1.schema.json`, validated by its own
  entry point `agents/skills/lib/contracts/tool-review.mjs` (the
  `critical-areas.mjs` pattern), which holds its five named rules and the
  `real-dates` check. `validate.mjs` and `rules.mjs` are not changed;
  `document.mjs` gains only the refusal message that points
  `canary.tool-review/1` to `tool-review.mjs`.
- New tool-side file `.canary/blackalice.overlay.json`, which lives in the
  reviewed tool's repository and never in canary.
- No new `canary` TypeScript CLI subcommand.

### Registrations Required

Derived from the most recent new-skill PR (`canary-unquarantine`, #1456,
`5524dace`) and the last PR that added a skill with a contract
(`canary-starling`, #1198, `df661b1c`):

- `.claude-plugin/plugin.json` — add
  `./agents/skills/claude-code/canary-blackalice` to the `skills` array (#1210
  precedent; guarded by `ts/test/plugin-skills.test.ts`).
- `agents/skills/package.json` — add
  `claude-code/canary-blackalice/scripts/*.mjs` to the `format:check` prettier
  globs, as for starling and unquarantine.
- `harness.config.json` — `scripts/cli.mjs` in **both** `entropy.entryPoints`
  and `performance.entryPoints`.
- `agents/skills/test/gate-conformance.test.ts` — the 0-walked abstention case
  (advisory by default, exit 3 under `--strict`).
- `agents/skills/vitest.config.ts` — add
  `claude-code/canary-blackalice/scripts/**/*.mjs` to `coverage.include`; the
  test file `test/canary-blackalice.test.ts` is already picked up by the
  `test/*.test.ts` include glob.
- `agents/skills/test/contracts-schemas.test.ts` — declare
  `tool-review.v1.schema.json`. The test requires the contracts directory to
  hold exactly the layer schemas plus `INPUT_SCHEMAS`, and every `INPUT_SCHEMAS`
  row asserts "no contract const", so this schema (which has a `contract` field)
  needs its own declared category there: a third list, `STANDALONE_CONTRACTS`,
  whose rows assert that `contract` is the schema's const. The existing
  `INPUT_SCHEMAS` guarantee is left as it is.
- A model-free test for the skill's scripts, modelled on
  `ts/test/gen-data-model-free.test.ts`.
- `docs/naming-registry.md` — the `canary-blackalice` row; its `Issue` must
  match the roadmap row's `External-ID` (`ts/test/bop-name-registry.test.ts`).
- `docs/roadmap.md` — the row promoted at spec sign-off.
- `.harness/arch/baselines.json` — expected module-size growth. The floor was
  refreshed to 55480 by #1514; a phase PR that still crosses it needs a branch
  allowance or a human `refresh-baseline` decision.

### Documentation Updates

- `AGENTS.md` — skill entry and the overlay-and-report-live-in-the-tool-repo
  rule.
- `agents/skills/README.md` — skill table row.
- `docs/specs/canary-tool-review-contract.md` — the contract, ledger states,
  named rules, exit codes and abstention rule.
- `docs/wiki/Tool-Review.md` — writing an overlay, running a review, reading the
  report.
- `CHANGELOG.md` — one `[Unreleased]` line per phase PR.

### Architectural Decisions

- **D9 → ADR "`canary.tool-review/1`: a ledger-first review contract"** — a new
  public contract alongside ADRs 0035/0036; records the four ledger states, the
  run-level `not_assessed`, the five named rules, and why the contract gets its
  own validator entry point. It also extends ADR 0035 D3's naming convention:
  layer contracts stay `canary.<layer>/<major>`, while standalone contracts use
  `canary.<name>/<major>`, and `<name>` may contain hyphens.
- **D3 + D11 → ADR "generic catalog, tool-owned overlay"** — sets the
  public/private boundary any future tool-facing skill will reuse.
- D6 and D8 apply existing ADR 0035/0036 rules and need no ADR of their own.

### Knowledge Impact

- Concepts: tool review, job catalog, persona, result-surface quality (Q1–Q4),
  coverage-ledger state, tool overlay, run-level abstention.
- Relationships: blackalice _reviews_ a tool's result surfaces; _uses_ the
  Playwright MCP; _dogfoods on_ the canary QA site built by `canary-barda`; Q2
  _applies_ the abstention rule of ADR 0035.

## Success Criteria

1. The shipped catalog has ≥30 jobs; every job names one of the 6 personas and 6
   stages; every persona has ≥3 jobs.
2. When `catalog check` runs on a valid catalog and overlay, the CLI prints the
   merged job count per persona and stage and exits 0.
3. If an overlay `disable` entry has no reason or names an unknown job id, then
   `catalog check` exits 1 naming the entry.
4. If an overlay's `auth.user` or `auth.secret` carries a value rather than an
   `env:` reference, then `catalog check` exits 1.
5. If a catalog file contains a denylisted term, then the leak gate
   (`scripts/check_removed_symbols.mjs`, the producer of the required
   `No removed-symbol or proprietary leaks` check, which scans `.json`) exits
   non-zero naming the file (except in the fork-visible `pull_request_target`
   log, which withholds file names by design). Proven by a planted-positive test
   that supplies a synthetic term through `CANARY_PROPRIETARY_DENYLIST` — never
   a real denylist term.

6. When `plan` runs, every merged job appears in the ledger as `pending`, with
   walk candidates ordered by `risk`.
7. If a `not-assessed` or `not-applicable` row is recorded without a reason, or
   a `walked`/`mapped` row without evidence, then `record` exits 1.
8. When `record --surface <path>` runs, a `kind: surface` row is created in the
   given state, subject to the same reason and evidence rules.
9. If any ledger row is still `pending`, then `report build` exits 1 listing
   those rows.
10. If the ledger has zero `walked` rows, then `report build` prints the
    abstention line (containing `abstained`, which the conformance registry
    asserts) first, writes no report file, and exits 0 — and exits 3 when run
    with `--strict` (gate-conformance case).

11. If a finding lacks evidence, cost or persona, the report fails schema
    validation; if it has both `job` and `quality` null, it fails the
    `jobOrQuality` rule.
12. If `not_assessed` is absent, then the report fails validation; `[]` is
    accepted.
13. When rendered to Markdown, the ledger counts and run-level abstentions
    appear before the first finding.
14. When `diff` runs on two reports, every finding is classified new, resolved
    or still open, and the change in each ledger state is printed.
15. The `noCompositeScore` rule refuses `score`, `overall`, `composite` or
    `rating` on the report or any finding.
16. `file` emits issue bodies only for the picked findings — or, with no
    `--pick`, only those marked `file_candidate` — and makes no tracker API
    call.

17. A review of the canary QA site's demo scope walks ≥5 jobs, applies Q1–Q4 to
    every visited result surface, and produces a valid report committed under
    `docs/reviews/`.
18. That review examines the site's no-runs state under Q2 and records either a
    finding (no-runs shown as green) or a `walked` pass.
19. A review of TestTracker, with its overlay and its report committed in
    TestTracker's repository, produces a valid report, and no overlay content,
    internal route or path, or screenshot from that review lands in the canary
    repository (leak gate and proprietary denylist clean). The tool's name
    itself is already public in canary and is not what this criterion guards.
20. A second review of the same target after fixes produces a `diff` with ≥1
    finding moved to resolved.

21. The skill's scripts import no LLM SDK, enforced by a model-free test for
    `canary-blackalice/scripts/` modelled on
    `ts/test/gen-data-model-free.test.ts`.

## Implementation Order

**Sub-project 1 — `canary-blackalice`** (one PR per phase, merged serially and
re-measured after each, because the repository's absolute ratchets do not
compose):

1. **Contract** — schema, `tool-review.mjs` entry point, the `jobOrQuality`,
   `noCompositeScore`, `evidenceRequired`, `ledgerCompanion` and `idsUnique`
   rules plus `real-dates` on `reviewed_at`, the `document.mjs` refusal pointer,
   contract doc, valid and per-rule invalid fixtures, ADR (ledger-first
   contract). Criteria 11, 12, 15.
2. **Catalog + overlay** — `jobs.v1.json`, `qualities.v1.json`, overlay merge,
   `catalog check`, ADR (catalog + tool-owned overlay). Criteria 1–5.
3. **Ledger + report CLI** — `plan`, `record` (incl. `--surface`),
   `report build` + render, `diff`, `file`, conformance and model-free tests.
   Criteria 6–10, 13, 14, 16, 21.
4. **Agent layer** — `SKILL.md` and every registration and doc listed under
   Integration Points.

**Sub-project 2 — canary QA site build-out** (its own short spec; can run in
parallel with phases 1–3):

- **Phase 5:** **Demo scope** — a synthetic `{ id: "demo", env: "showcase" }`
  feed with 30 runs per suite and red, green, dark and flaky suites, failures
  with traces and register debt, passing `canary.site/1` validation including
  the `real-dates` rule.
- **Phase 6:** **Deploy** — the QA site spec's phase 5 (`site-deploy.yml` to
  Vercel), blocked on the human for `VERCEL_*` secrets and its stated
  Vercel-status precondition.

**Dogfood loop** (needs 4 and 6):

- **Phase 7:** First review of the canary site; its findings, after
  confirm-first filing, become the site backlog (criteria 17, 18).
- **Phase 8:** Build what it found.
- **Phase 9:** Second review and `diff` (criterion 20).
- **Phase 10:** TestTracker review, with the overlay and report landed in that
  repository separately (criterion 19).

The QA site's phase 4 (`canary-vixen` embed) stays deferred; nothing here
depends on it.
