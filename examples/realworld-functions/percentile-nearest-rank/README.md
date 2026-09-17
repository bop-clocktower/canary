# Example: Percentile (Nearest Rank)

Tests a `percentile` function that returns the p-th percentile of an integer
sample using the nearest-rank method.

This is a **Vitest unit** example, and — like `pagination-cursor-codec` — its
whole contract is integer-only by design. "Percentile" has at least nine
published definitions, so an unpinned prompt makes every expected value
arguable; pinning the estimator to the digit is what makes the function testable
at all. The formula here is deliberately exact integer arithmetic:
`rank = ceil((p * N) / 100)` with the multiply performed _before_ the divide, so
`p = 40, N = 5` gives `200 / 100 = 2` and never `2.0000000000000004`.

Two assertions naive implementations miss. Case 2 is the **exact-multiple
discontinuity** — `ceil` does not advance the rank when the division lands on a
whole number, so `p = 30` and `p = 40` return the _same_ element of this sample
while `p = 50` moves on. Case 6 is **purity** — a `values.sort()` on the
argument instead of a copy passes every other case and silently reorders the
caller's array.

## Prompt

```text
Generate Vitest unit tests for a percentile function.

Signature:
    function percentile(values: number[], p: number): number

The function returns the p-th percentile of an integer sample using the
nearest-rank method.

Rules:
  - `values` must be a non-empty array of integers. An empty array, or any
    non-integer element, throws a RangeError — input is rejected, never
    rounded or coerced.
  - `p` must be an integer in the inclusive range 0 to 100. A fractional `p`
    (e.g. 50.5) or one outside the range throws a RangeError.
  - Sort a COPY of `values` ascending. The caller's array is never mutated.
  - Compute the 1-based rank as:  rank = ceil((p * N) / 100)  where N is the
    number of values. Perform the multiply BEFORE the divide — `p * N` is an
    exact integer, so the division never introduces floating-point drift.
  - Clamp the rank to the range 1 to N, then return the element at that
    1-based rank.
  - The function is pure.
  - Note the consequence of `ceil`: when `(p * N) / 100` lands on an exact
    integer, the rank does NOT advance. Percentiles that fall between two
    exact multiples therefore share an answer.

Cover these cases (hand-verified against the formula, sample
[15, 20, 35, 40, 50] with N = 5):
  1. Midpoint — percentile([15, 20, 35, 40, 50], 50) -> 35
     (50 * 5 = 250, 250 / 100 = 2.5, ceil = 3, element 3 = 35)
  2. Exact multiple does NOT round up —
     percentile([15, 20, 35, 40, 50], 40) -> 20
     (40 * 5 = 200, 200 / 100 = 2 exactly, ceil = 2, element 2 = 20)
  3. Top of the range — percentile([15, 20, 35, 40, 50], 100) -> 50
     (100 * 5 = 500, 500 / 100 = 5, element 5 = 50)
  4. Bottom of the range, rank clamped up from 0 —
     percentile([15, 20, 35, 40, 50], 0) -> 15
     (0 * 5 = 0, ceil = 0, clamped to 1, element 1 = 15)
  5. Single-element sample — percentile([7], 37) -> 7
     (37 * 1 = 37, 37 / 100 = 0.37, ceil = 1, element 1 = 7)
  6. Unsorted input is sorted internally and the caller's array is
     unchanged — percentile([50, 15, 40, 20, 35], 50) -> 35, and the array
     passed in still reads [50, 15, 40, 20, 35] afterwards
  7. Empty sample — percentile([], 50) -> throws RangeError
  8. Invalid p — percentile([15, 20, 35, 40, 50], 101) -> throws RangeError,
     and percentile([15, 20, 35, 40, 50], 50.5) -> throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/percentile-nearest-rank
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (pure numeric function, TS signature)
2. Pick `vitest` from the framework registry
3. Write a `percentile.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight tests covering the rank arithmetic, both clamps, and the rejection paths.
The exact-multiple case and the purity check are the two that separate an
estimator-aware suite from a plausible-looking one:

```typescript
it('does not advance the rank at an exact multiple', () => {
  // 40 * 5 = 200; 200 / 100 = 2 exactly; ceil(2) = 2 -> element 2
  expect(percentile([15, 20, 35, 40, 50], 40)).toBe(20);
  // ...and 30 shares that answer: 150 / 100 = 1.5, ceil = 2
  expect(percentile([15, 20, 35, 40, 50], 30)).toBe(20);
});

it('sorts a copy and leaves the caller array untouched', () => {
  const sample = [50, 15, 40, 20, 35];
  expect(percentile(sample, 50)).toBe(35);
  expect(sample).toEqual([50, 15, 40, 20, 35]);
});
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/percentile.test.ts
```

## Variations to try

- **Linear interpolation:** ask for a second function using the
  linear-interpolation estimator instead, then a test contrasting the two on the
  same sample — the pair makes visible how much the _choice_ of estimator moves
  the answer
- **Fractional samples:** relax `values` to accept finite non-integer numbers
  while keeping `p` an integer, and ask which of the eight cases have to change
  — the rank arithmetic does not, which is the point
- **Batch percentiles:** ask for `percentiles(values, ps: number[]): number[]`
  computing several at once from a single sort, plus a test proving it agrees
  with calling `percentile` once per `p`

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
