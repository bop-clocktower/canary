# Example: Money Allocator

Tests an `allocate` function that splits an integer cent amount across a list of
ratios so the parts **sum exactly to the total** — the largest-remainder method,
with no penny created or lost.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. Splitting
money looks like multiply-and-round until you hit an indivisible remainder:
`100` across three equal parts can't be `33.33` each, so *someone* gets the extra
cent. The interesting surface is exactly that — which part gets the leftover, and
the invariant that the parts always re-sum to the input.

## Prompt

```text
Generate Vitest unit tests for an allocate function.

Signature:
    function allocate(totalCents: number, ratios: number[]): number[]

The function splits an integer cent amount across a list of ratios so that the
returned integer parts sum **exactly** to the total — no penny is created or
lost. It uses the largest-remainder method.

Allocation rules:
  - Compute each part's ideal share: totalCents * ratio_i / sum(ratios).
  - Floor each ideal to an integer. The leftover cents (totalCents minus the sum
    of the floors) are handed out one at a time to the parts with the largest
    fractional remainder.
  - Ties on the fractional remainder are broken by lowest index (earlier ratios
    win the extra cent).
  - Headline invariant: sum(allocate(t, r)) === t for every valid input.
  - A ratio of 0 receives 0. totalCents may be 0 (all parts 0).
  - Empty ratios, all-zero ratios, or any negative input throw a RangeError.

Cover these cases:
  1. Even split — allocate(100, [1, 1, 1, 1]) → [25, 25, 25, 25]
  2. Equal remainders, tie to lowest index — allocate(100, [1, 1, 1]) → [34, 33, 33]
  3. Distinct remainders, two leftover cents to the two largest — allocate(100, [3, 3, 1]) → [43, 43, 14]
  4. Clean weighted split (no remainder) — allocate(1000, [7, 2, 1]) → [700, 200, 100]
  5. Single ratio takes everything — allocate(999, [5]) → [999]
  6. Zero ratio receives nothing — allocate(100, [1, 0, 1]) → [50, 0, 50]
  7. Zero total — allocate(0, [1, 2, 3]) → [0, 0, 0]
  8. Empty or all-zero ratios — allocate(100, []) → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/money-allocator
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write an `allocate.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('allocate')` block.
The remainder-distribution cases are where naïve `Math.round` implementations
break the sum:

```typescript
it('hands equal remainders to the lowest index', () => {
  expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
})

it('never creates or loses a cent', () => {
  expect(allocate(100, [3, 3, 1]).reduce((a, b) => a + b, 0)).toBe(100)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/allocate.test.ts
```

The tests import an `allocate` stub — paste your real implementation or point the
import at your module before running.

## Variations to try

- **Property check:** ask Canary to add a `test.each` (or fast-check) case
  asserting `sum(allocate(t, r)) === t` across a table of random totals and ratios
  — the invariant is the whole point, so prove it holds broadly
- **Round-half-up contrast:** ask for a second function that rounds each part
  independently and a test showing it can drift off the total by a cent — makes
  the largest-remainder guarantee concrete
- **Payout shape:** change ratios to `{ accountId, weight }[]` and return
  `{ accountId, cents }[]` so the example reads like a real payout splitter

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
