---
name: canary-fleet-health
description: >
  Fleet-wide test health summary across suites — flaky tests, failure
  spikes, cross-suite common failures, and regression candidates from the
  run-history store. Use when the user asks "how healthy is our test fleet",
  "fleet-wide flake report", "any regressions this week", "failure spikes
  across suites", or "canary analyze". Produces one compact, scannable
  summary — not a dashboard. NOT for diagnosing a single known-flaky test
  (canary-flake-hunter) or scoring one suite's CI readiness
  (canary-ci-ready).
---

# Canary: Fleet Health

Wraps `canary analyze` (fleet-wide flake/spike/regression analytics) and the
run-history store to answer "how's the whole fleet doing?" in one chat-turn
summary. Today, [`canary-flake-hunter`](../../../canary-flake-hunter.md)
only diagnoses a single test you already suspect is flaky — this skill is
the fleet-wide counterpart: it tells you *where to look* before you reach
for the hunter.

Per the adoption audit this skill implements (candidate #10), this is
deliberately a **low-cost validation step**: a compact text summary a human
can scan in one turn, not a dashboard or visual surface. If fleet-wide
analytics prove valuable, a richer surface is a separate, larger
investment — don't over-build this one.

## When to Use

- Weekly/periodic health check: "how's the test fleet looking?"
- Before a release: "any regressions or spikes we should know about?"
- Triaging where to spend test-maintenance effort across many suites
- NOT for a single test you already know is flaky — use
  [`canary-flake-hunter`](../../../canary-flake-hunter.md) to diagnose root
  cause and propose a fix
- NOT for scoring one suite's CI readiness — use
  [`canary-ci-ready`](../canary-ci-ready/SKILL.md) (coverage depth,
  assertion quality, runtime for *one* suite)
- NOT a substitute for `.canary/critical-areas.json` risk ranking — use
  [`canary-critical-areas`](../canary-critical-areas/SKILL.md) for
  code-level risk, this skill is history-data-level health

## Process

### Phase 1: RESOLVE THE STORE

Fleet analytics read from the run-history store, not from a live test run.
Before running anything, confirm data exists:

```bash
python -m agent.cli history summary <suite> --runs 1
```

- **Configured store:** `CANARY_HISTORY_DB_URL` env var (Supabase-backed) or
  falls back to the local NDJSON file at
  `test-results/reports/history-v2.jsonl`.
- **No local file and no `CANARY_HISTORY_DB_URL`:** there is nothing to
  analyze yet. Say so plainly — "No run history found. Push results with
  `canary history push` after a CI run, or run `canary history migrate` if
  you have v1 history.jsonl data." Do not fabricate a health summary from
  nothing.

### Phase 2: RUN THE RELEVANT ANALYSES

Default to the combined digest unless the user asked about one specific
dimension:

```bash
python -m agent.cli analyze digest --json
```

If the user asked about one thing specifically, run only that subcommand
instead of the full digest — cheaper and more focused:

| User asks about | Command |
| --- | --- |
| Flaky tests fleet-wide | `canary analyze flaky --window 30 --min-rate 10 --json` |
| Failure spikes | `canary analyze spikes --delta 20 --json` |
| Cross-suite common failures | `canary analyze common-failures --min-suites 2 --json` |
| Newly broken tests after a green streak | `canary analyze regression-candidates --json` |
| "Area health" / degrading areas | See the caveat below — this dimension does not currently return data |

**Known limitation — be upfront about it:** `canary analyze area-health`
(and the `area_health` section of `digest`) is currently wired to an empty
data set in `agent/analysis/cli.py` / `agent/analysis/engine.py` — it always
reports "No area health data available," regardless of history. Don't
present this as a working check; tell the user area-degradation tracking
isn't implemented yet rather than silently omitting it.

**Store-type caveat:** `flaky` queries the store directly and works with
either backend. `spikes`, `common-failures`, and `regression-candidates`
currently only populate fully when the backing store is the local NDJSON
file (`AnalysisEngine` special-cases `LocalHistoryStore` for suite
discovery and per-test aggregation) — with a Supabase-backed store
(`CANARY_HISTORY_DB_URL` set), those three may come back empty even with
real history. If the digest shows all-zero spikes/common-failures/
regressions *and* `CANARY_HISTORY_DB_URL` is set, flag this as a likely
store-support gap, not a clean bill of health.

### Phase 3: CONDENSE TO ONE SCREEN

Don't paste raw Markdown tables from the CLI — they're built for file
artifacts, not chat. Pull the top 3–5 rows per section and compress to the
Output Format below. If a section is empty, say "none" in one line; don't
render an empty table.

### Phase 4: SURFACE THE ONE ACTIONABLE THING

Look across sections for correlation — e.g., a suite with both a recent
spike and several tests over the flake threshold is a stronger signal than
either alone. Call that out explicitly as the suggested next step, and name
the specific downstream skill:

- Single suspicious test → point at
  [`canary-flake-hunter`](../../../canary-flake-hunter.md)
- Whole suite trending down → point at
  [`canary-ci-ready`](../canary-ci-ready/SKILL.md) for that suite
- Systemic cross-suite pattern (e.g. the same connection error in 3 suites)
  → this is infrastructure/environment, not a test bug; say so instead of
  suggesting a test fix

## Output Format

```text
Fleet Health — window: 30 runs

  Flaky (≥10%):        3 tests   top: checkout_retry_test (32%, api suite)
  Spikes (≥20pp):      1 suite   e2e_ui +25pp since 2026-07-10
  Area health:         not available (not yet implemented — always empty)
  Common failures:     1 pattern  "ECONNREFUSED 127.0.0.1:5432" across 2 suites
  Regressions:         2 tests   orders_post_201 broke after 12-run green streak

  Suggested next step: e2e_ui's spike + 2 of the 3 flaky tests are in that
  suite — investigate the suite before chasing individual flakes.
  Run /canary-ci-ready on e2e_ui, or /canary-flake-hunter on
  checkout_retry_test for a root-cause fix.
```

Keep it to one screen. Omit a line entirely rather than padding with "no
data" noise for sections that were never requested.

## Flags

- `--window <n>` — rolling run window for flaky/spikes (default: 30, passed
  through to `canary analyze`)
- `--suite <name>` — scope to one suite instead of the whole fleet
- `--json` — pass through the underlying CLI's `--json` when the caller
  wants structured data instead of a chat summary

## Error Handling

| Situation | What To Do |
| --- | --- |
| No history data at all (fresh repo) | Say so; point at `canary history push` / `canary history migrate`. Don't run the analysis commands against nothing. |
| `CANARY_HISTORY_DB_URL` set but Supabase unreachable | `make_store` only guards against a missing `agent.history.supabase_store` import, not a live connection failure — a query error will surface as a CLI exception. Report the exception text, suggest checking connectivity/credentials, don't retry silently. |
| `area-health` requested explicitly | Explain the known limitation (Phase 2) rather than showing an empty table with no context. |
| Digest looks suspiciously all-zero with `CANARY_HISTORY_DB_URL` set | Flag the store-type caveat (Phase 2) before concluding the fleet is healthy. |
| User wants a specific suite that has no history | `canary history summary <suite>` returns `total_runs: 0` — report that directly instead of running the full fleet analysis. |

## Examples

### Example: Weekly health check with a correlated signal

**Prompt:** "How's the fleet looking this week?"

**Action:** Confirm local history file exists. Run `analyze digest --json`.
Condense: 3 flaky tests (2 in `e2e_ui`), 1 spike (`e2e_ui`, +25pp), no common
failures, 2 regression candidates. Correlate: `e2e_ui` shows up in both flaky
and spikes — call it out as the priority, suggest `canary-ci-ready` on
`e2e_ui` before chasing the individual flaky tests.

### Example: No history yet

**Prompt:** "Give me a fleet health summary."

**Action:** `history summary api --runs 1` returns `total_runs: 0` and no
local NDJSON file exists. Report plainly: no run history is available yet;
point at `canary history push` after the next CI run. Do not run `analyze
digest` against an empty store and present an empty report as "all clear" —
absence of data is not evidence of health.

## Related Skills

- [`canary-flake-hunter`](../../../canary-flake-hunter.md) — single-test
  root-cause diagnosis once fleet health points at a candidate
- [`canary-ci-ready`](../canary-ci-ready/SKILL.md) — single-suite CI
  readiness scoring (coverage, assertions, runtime)
- [`canary-critical-areas`](../canary-critical-areas/SKILL.md) —
  code-level risk ranking, a different signal from history-based health
