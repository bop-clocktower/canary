---
name: canary-critical-areas
description: >
  Risk-based test prioritisation. Given a codebase or diff, identifies which
  areas carry the most risk using git churn, downstream dependents,
  business-critical signals, and existing coverage depth. Produces a ranked list
  with recommended test types per area.
---

# Canary: Critical Areas

Identifies the highest-risk areas of a codebase so test effort goes where it
matters most. Uses multiple signals, degrades gracefully when advanced tooling
is unavailable.

## When to Use

- Before writing new tests: "where should I focus?"

- After a large diff lands: "what did this change put at risk?"

- As Phase 1 of `/canary-test-pipeline`

- When asked to prioritise test coverage

## Signals

Collect all available signals, score each area, and rank by composite risk
score.

### 1. Churn / hotspot (always available)

**With harness MCP available:** call `detect_anomalies` (metric `hotspotScore`,
plus its co-change / single-point-of-failure signals). Harness's hotspot score
already blends churn with structural risk, so use it directly as this signal and
skip the raw `git log` pass. Normalise the returned scores to 0–1.

**Fallback (no MCP):**

````bash
git log --stat --since="90 days ago" -- <path> | grep -c "^"
```text

Files changed most frequently in the last 90 days score higher. Normalise to
0–1 across all files in scope.

### 2. Downstream dependents

**With harness MCP available:** call `get_impact` for each candidate file
(`filePath`, `mode: "summary"`) and read the affected-node counts it returns
(tests / docs / code grouped by type). This is the purpose-built impact
primitive — do **not** hand-walk `get_relationships` edge-by-edge; `get_impact`
already computes the transitive downstream set. More affected nodes ⇒ higher
score.

**Fallback (no MCP):** scan for `import` statements referencing each file using
`grep -r`. Count unique files that import each candidate.

Files with more inbound dependents score higher — a change here breaks more.

### 3. Business-critical / critical-path flags

**With harness MCP available:** call `get_critical_paths` and add a fixed boost
(+0.3) to any area whose functions appear in the returned perf-critical set.
Also query `ask_graph` for `business_fact` nodes associated with each area; any
business-critical annotation adds the same +0.3 boost (apply the boost once,
whichever signal fires).

**Fallback:** skip this signal silently (do not penalise the score).

### 4. Coverage depth boost

If `.canary/test-inventory.json` is present: files whose endpoints are at
depth 0 or 1 receive a boost (+0.15) — low depth in a high-churn file is
especially risky.

## Risk Score

```text
risk_score = (churn * 0.35) + (dependents * 0.35) + (business_critical * 0.30) + depth_boost
```text

Capped at 1.0. Round to 2 decimal places.

## Output

```text
Critical areas — <repo> (<N> files analysed)

  1. src/loyalty/points.service.ts       risk 0.92  ████████████
     signals: high churn · 12 dependents · business_critical
     recommended: api + integration tests

  2. src/billing/charge.service.ts       risk 0.78  ██████████
     signals: high churn · billing domain
     recommended: api tests · /canary-failure-impact suggested

  ...
```text

Show at most 10 areas. If more than 10 qualify, note the total and offer to
show all.

## Optional Artifact

When `--save` flag is passed (or when invoked by `/canary-test-pipeline`),
write `.canary/critical-areas.json`:

```json
{
  "generated": "<ISO timestamp>",
  "areas": [
    {
      "path": "src/loyalty/points.service.ts",
      "risk_score": 0.92,
      "signals": ["high_churn", "many_dependents", "business_critical"],
      "recommended_test_types": ["api", "integration"],
      "summary": "High-churn service with 12 downstream dependents"
    }
  ]
}
```text

This file is consumed as opt-in context by `/canary-edge-cases` and
`/canary-failure-impact`.

## Flags

- `--diff <git ref>` — scope analysis to files changed in a diff
  (`git diff <ref>...HEAD`)

- `--save` — write `critical-areas.json`

## Related skills

- `/canary-ci-ready` — check 4 consumes `critical-areas.json`

- `/canary-edge-cases` — focuses edge cases on critical areas when JSON present

- `/canary-failure-impact` — focuses tracing on critical paths when JSON present

- `/canary-test-pipeline` — Phase 1
````
