---
name: canary-critical-areas
description: >
  Risk-based test prioritisation. Given a codebase or diff, identifies which
  areas carry the most risk using git churn, downstream dependents,
  business-critical signals, and existing coverage depth. Produces a ranked
  list with recommended test types per area.
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

Collect all available signals, score each area, and rank by composite risk score.

### 1. Git churn (always available)

```bash
git log --stat --since="90 days ago" -- <path> | grep -c "^"
```

Files changed most frequently in the last 90 days score higher. Normalise to
0–1 across all files in scope.

### 2. Downstream dependents

**With harness MCP available:** call `get_relationships` for each candidate file
and count inbound `imports` / `depends_on` edges.

**Fallback (no MCP):** scan for `import` statements referencing each file using
`grep -r`. Count unique files that import each candidate.

Files with more inbound dependents score higher — a change here breaks more.

### 3. Business-critical flags

**With harness MCP available:** query `ask_graph` for `business_fact` nodes
associated with each area. Any business-critical annotation adds a fixed boost
(+0.3) to the risk score.

**Fallback:** skip this signal silently (do not penalise the score).

### 4. Coverage depth boost

If `.canary/test-inventory.json` is present: files whose endpoints are at
depth 0 or 1 receive a boost (+0.15) — low depth in a high-churn file is
especially risky.

## Risk Score

```
risk_score = (churn * 0.35) + (dependents * 0.35) + (business_critical * 0.30) + depth_boost
```

Capped at 1.0. Round to 2 decimal places.

## Output

```
Critical areas — <repo> (<N> files analysed)

  1. src/loyalty/points.service.ts       risk 0.92  ████████████
     signals: high churn · 12 dependents · business_critical
     recommended: api + integration tests

  2. src/billing/charge.service.ts       risk 0.78  ██████████
     signals: high churn · billing domain
     recommended: api tests · /canary-failure-impact suggested

  ...
```

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
```

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
