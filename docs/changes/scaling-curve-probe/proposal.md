---
name: Scaling-curve probe
status: approved
type: advisory
owner: ahhrealmonster
created: 2026-09-10
related_decisions:
  - docs/knowledge/decisions/0009-exit-3-reserved-for-abstained.md
supersedes_decisions: []
introduces_adrs: []
---

# Scaling-curve probe (#856)

**Keywords:** load, performance, scaling, growth exponent, knee, k6, abstention,
surge

## Overview

Fixed-size load tests answer "does it hold at N?". They do not answer "how does
cost grow as N grows?". A component whose work grows faster than its input (a
matcher comparing each new record against a growing list, O(n·m)) passes every
fixed-size run and then buckles at the moment input peaks. In a surge-driven
system that is the worst possible timing, and it is predictable in advance if
someone measures the curve.

The probe fits the growth exponent (log-log slope) of a cost metric against
input size, reports where the curve bends, and abstains when the data cannot
support a verdict.

## Decisions

| Decision          | Choice                                                         | Why                                                                                                                                              |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analyse vs run    | **B then A.** Phase 1 analyses points; Phase 2 runs the ladder | The fit and the abstention rules live in one pure, testable module. The runner is a thin producer of points and cannot disagree with the verdict |
| Gate or advisory  | Advisory (exit 0 on a verdict)                                 | A planning signal, not a CI gate (#856 constraint)                                                                                               |
| Insufficient data | Exit 3, `INSUFFICIENT_DATA`, reason stated                     | "Linear ✓" off three noisy samples is a false green (ADR 0009)                                                                                   |
| Samples per size  | Median of repeats                                              | Robust to a single outlier run                                                                                                                   |

## Phase 1: `canary scaling-curve <points-file>`

Input: JSON `{ "metric": "p95_ms", "points": [{ "size": 1000, "value": 42 }] }`
or CSV with `size,value` header. Repeated sizes are samples.

Verdict rules (in `ts/src/core/scaling-curve.ts`, pure):

1. **Abstain** (`INSUFFICIENT_DATA`) when any of:
   - fewer than 4 distinct sizes;
   - size span (max / min) below 8×;
   - any size with ≥ 3 samples whose coefficient of variation exceeds 0.25;
   - log-log fit R² below 0.9;
   - any size or value ≤ 0 or non-finite.
2. Otherwise fit `log(value) = b·log(size) + a` by least squares and classify:
   - `b ≤ 1.15` → `LINEAR_OR_BETTER`
   - `1.15 < b ≤ 1.6` → `SUPERLINEAR` (n log n territory)
   - `b > 1.6` → `STRONGLY_SUPERLINEAR` (quadratic territory)
3. **Knee:** the first size where the segment slope to the next size exceeds the
   first segment's slope by ≥ 0.5; `null` when the curve does not bend.
4. `--target N` extrapolates the fitted value at size N, labelled as an
   extrapolation, with the multiple of the largest measured size.

Output always carries the raw (median) points, exponent, R², and the rules that
fired, so a human can check the fit.

## Phase 2: `--run <k6-script> --sizes 1000,2000,4000,8000,16000`

Runs the script once per size with `SIZE` in the environment, reads the metric
from k6's `--summary-export`, and feeds the points to Phase 1 unchanged.
`--repeats N` (default 3) supplies samples for the noise rule. A missing metric
is an abstention, never a zero.

## Non-goals

- No production data. Synthetic inputs only.
- No CI gating. No new runner beyond invoking k6.
- Not a load test. It says how cost grows, not whether a size is survivable.

## Success criteria

- A synthetic O(n²) point set is classified `STRONGLY_SUPERLINEAR` with b ≈ 2.
- An O(n) set with a knee at 8× reports that knee.
- Three sizes, a 4× span, a noisy size, or a poor fit each abstain with exit 3
  and name the rule.
- The JSON output is parseable when abstaining.
