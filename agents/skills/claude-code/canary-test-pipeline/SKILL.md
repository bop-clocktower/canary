---
name: canary-test-pipeline
description: >
  Multi-phase orchestrator that composes canary-ci-ready, canary-critical-areas,
  canary-edge-case-discovery, canary-failure-impact, and canary-write-test into
  a sequential pipeline with a convergence loop and health report.
---

# Canary: Test Pipeline

Runs the full test intelligence pipeline from risk assessment to verified CI
readiness. Follows the same pattern as `harness:docs-pipeline` and
`harness:knowledge-pipeline` — sequential phases, convergence loop, qualitative
health report on exit.

## When to Use

- Starting a new test suite from scratch

- Improving a suite that is not yet CI-ready

- After a major feature lands and test coverage needs updating

- When asked to "bring this suite to CI-ready"

## Phases

### Phase 0 — Probe, then gate (`/canary-ci-ready`)

**Probe for the harness MCP exactly once, here, and thread the result through
every later phase.** Several sub-skills (`canary-critical-areas`,
`canary-failure-impact`, `canary-ci-ready`) each adapt to whether harness
primitives are available. Left alone they rediscover that independently, which
is wasted work and — worse — can yield an inconsistent run where one phase
scores against the graph and another silently falls back.

Record the probe result once:

```text
harness: available    → phases may call get_impact, get_critical_paths,
                        get_perf_baselines, ask_graph
harness: unavailable  → every phase uses its documented fallback
```

Pass that verdict to each phase rather than letting it re-probe. If the probe is
ambiguous, treat harness as **unavailable** — a consistent weaker run beats a
run whose fidelity varies by phase, because a mixed run's health report cannot
be compared against any previous one.

Then run `canary-ci-ready` as a baseline.

- If **CI-READY**: inform the user and offer to exit or run an improvement sweep
  anyway.

- If **NOT CI-READY**: show the score, continue to Phase 1.

### Phase 1 — Assess (`/canary-critical-areas`)

Run `canary-critical-areas` on the repo (or `--diff` if provided). Save
`critical-areas.json` automatically (no `--save` required when run inside the
pipeline).

Present the top 5 areas and ask the user to confirm or trim the list before
continuing.

### Phase 2 — Discover (`/canary-edge-cases`)

For each confirmed critical area from Phase 1, run `canary-edge-case-discovery`
with the area as context (passed via `critical-areas.json`).

Group edge cases by critical area. Present the full list before Phase 3 so the
user can review.

### Phase 3 — Impact (`/canary-failure-impact`)

For each high-risk path (risk_score ≥ 0.7 from Phase 1), run
`canary-failure-impact`. Use `critical-areas.json` as context.

Annotate each gap with its severity (Critical / High / Medium / Low).

### Phase 4 — Generate (`/canary-write-test`)

Present the consolidated gap list sorted by: severity (Critical first) then
depth (0 before 1 before 2). Include edge cases from Phase 2 as test variant
suggestions for each gap.

For each gap, ask the user to confirm before invoking `canary-write-test`. Do
not generate tests silently.

After generation, show a summary of files written before proceeding to Phase 5.

### Phase 5 — Verify (`/canary-ci-ready`)

Re-run `canary-ci-ready`. Show the delta — which checks improved, which remain
failing.

If any check still fails, investigate using the same user-catalog logic defined
in `canary-ci-ready`: auth/config failures get a catalog lookup before being
declared blockers.

## Convergence

After Phase 5:

- **ci-ready passes** → emit health report and exit

- **no new gaps found** (Phase 1 produces empty list) → emit health report, note
  remaining gaps are outside current signal, suggest manual review

- **gaps remain and user confirms** → loop back to Phase 1

- **user stops** → emit health report with current state

## Health Report

Emit on every exit (convergence or user stop):

```text
Test Pipeline — run complete

  Areas assessed:   N   →  N now at depth 3+  (+N this run)
  Tests written:    N   →  N critical paths now covered
  Gaps remaining:   N   →  <top gap names>
  CI-Ready:         CI-READY  or  NOT CI-READY (N/5 checks)

  <if not ready> Next: /canary-test-pipeline --continue, or address manually.
```

Also **write the report to `.harness/analyses/`** on every exit, so harness's
pre-merge tooling can cite the pipeline's verdict instead of it living only in
session scrollback. Record the harness-availability verdict from Phase 0 in the
record: a run that used fallbacks throughout is not comparable to one scored
against the graph, and a reader needs to know which they are looking at.

If the analyses channel is unavailable, say so loudly and still emit the report
to the session — degrade, never drop. (Same producer contract the guardian's
`--emit-analysis` follows.)

## Flags

- `--continue` — skip the Phase 0 **baseline** (resume a prior run). The Phase 0
  **probe still runs** — it is what every later phase depends on, so skipping it
  would leave the resumed run with no availability verdict at all.

- `--diff <ref>` — pass to `canary-critical-areas` to scope assessment to a diff

- `--threshold <n>` — pass to `canary-ci-ready` (default: 2)

## Related skills

- `/canary-ci-ready` — Phase 0 and convergence gate

- `/canary-critical-areas` — Phase 1

- `/canary-edge-cases` — Phase 2

- `/canary-failure-impact` — Phase 3

- `/canary-write-test` — Phase 4
