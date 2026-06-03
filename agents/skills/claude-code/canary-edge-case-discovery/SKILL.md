---
name: canary-edge-case-discovery
description: >
  Given a feature description, function signature, or existing test suite,
  surfaces edge cases worth testing across six categories. Explanation depth
  scales to user skill level. Optionally focuses on critical areas when
  critical-areas.json is present.
---

# Canary: Edge Case Discovery

Surfaces the edge cases that tests typically miss: the inputs and conditions
that work in demos but break in production.

## When to Use

- After writing happy-path tests: "what else should I test?"

- When reviewing a feature for robustness

- As Phase 2 of `/canary-test-pipeline`

- When asked "what edge cases should I cover?"

## Input

Provide one of:

- A feature description: `"points accrual on tier upgrade"`

- A function signature: `accruePoints(memberId: string, amount: number): Promise<Result>`

- A test file path: `tests/loyalty/points.spec.ts`

- Or nothing — Canary will infer from open files and recent context

If `.canary/critical-areas.json` is present, focus edge case discovery on the
highest-risk areas first (rank_score ≥ 0.6).

## The Six Categories

For each category, generate specific, actionable cases — not generic advice.

### 1. Boundary values

Zero, negative, max integer, empty string, null, undefined, one-off-by-one.
For amounts: 0, 1, MAX_SAFE_INTEGER, -1, 0.001 (floating point).
For strings: empty string, whitespace-only, max-length + 1 character.

### 2. Race conditions

Concurrent writes to the same resource. Double-submit (user clicks twice).
Stale reads after an update. Lock contention. Out-of-order async responses.

### 3. Locale and timezone

DST transition times. Dates at midnight UTC vs local time. Non-ASCII characters
in names and addresses. RTL text in string fields. Locale-specific number
formats (1.000,00 vs 1,000.00). Emoji in text fields.

### 4. Partial network

Request timeout mid-flight. Dropped connection after partial response. Retry
storms (client retries while server is still processing). Response truncation.

### 5. Unexpected input shapes

Extra fields the schema doesn't expect. Missing required fields. Wrong types
(string where number expected). SQL or script injection strings. Deeply nested
objects. Arrays where scalars expected.

### 6. Accessibility

Keyboard-only navigation paths. Missing ARIA labels. Focus trap conditions.
Screen reader text for dynamic content. Colour contrast for status indicators.
*(Only include if the input is a UI feature or test.)*

## Output Depth

Governed by `--level` flag. Infer from context when not specified:

- User is asking from a test file or uses technical language → `sdet`

- User describes themselves as new or asks "why" questions → `junior`

- User mentions manual testing or is non-technical → `manual`

| Level | Audience | Output style |
| ------- | ---------- | ------------- |
| `sdet` | Senior SDETs | Bullet list of cases only |
| `junior` | Junior SDETs | Cases + one-line *why this matters* |
| `manual` | Manual testers | Cases + numbered reproduction steps |

## Output Format (`sdet` example)

```text
Edge cases — points accrual on tier upgrade

  Boundary values
  · amount = 0
  · amount = MAX_SAFE_INTEGER
  · memberId empty string
  · memberId with special characters

  Race conditions
  · concurrent accrual calls for the same memberId
  · double-submit within 100ms

  ...

  Suggested next: /canary-write-test "add edge case tests for accruePoints boundary values"
```text

## Flags

- `--level sdet|junior|manual` — output depth (default: inferred)

## Related skills

- `/canary-critical-areas` — produces `critical-areas.json` used for focus

- `/canary-write-test` — generates tests for the surfaced cases

- `/canary-test-pipeline` — Phase 2
