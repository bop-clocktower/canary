# Example: Discount Stacking

Tests an `applyDiscounts` function that applies an ordered list of percentage and
fixed-amount discounts to a subtotal, clamped at zero, with an optional cap on
the total discount.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. Stacking
discounts looks like a simple subtraction loop until you notice the order
matters: because a percentage applies to the *running* total, **"10% off then $5
off" and "$5 off then 10% off" produce different prices.** A robust suite has to
prove the implementation honors the declared order rather than silently
commuting it — plus the rounding, the clamp-at-zero floor, and the total-discount
cap.

## Prompt

```text
Generate Vitest unit tests for an applyDiscounts function.

Signature:
    type Discount = { type: "percent" | "fixed"; value: number }

    function applyDiscounts(
        subtotalCents: number,
        discounts: Discount[],
        capCents?: number,
    ): number

The function applies an ordered list of discounts to a subtotal and returns the
final price in cents. Discounts stack sequentially — each one applies to the
running total left by the previous one — so the ORDER of the list changes the
result.

Stacking rules:
  - Process discounts in array order against a running total that starts at
    subtotalCents.
  - A "percent" discount removes round(running * value / 100) cents (round
    half-up to the nearest cent). `value` is a percentage, e.g. 10 means 10%.
  - A "fixed" discount removes `value` cents.
  - After each discount the running total is clamped at 0 — discounts never make
    the price negative.
  - If capCents is provided and the total discount (subtotalCents minus the
    running total) exceeds it, clamp so the final price is subtotalCents minus
    capCents. The cap bounds the TOTAL discount and is applied once, at the end.
  - An empty discount list returns subtotalCents unchanged.
  - A negative subtotalCents, discount value, or capCents throws a RangeError.

Because percent discounts apply to the running total, "10% then $5 off" and
"$5 off then 10%" produce different prices — that is the contract under test.

Cover these cases:
  1. Single percent — applyDiscounts(10000, [{ type: "percent", value: 10 }]) → 9000
  2. Order: percent then fixed — applyDiscounts(10000, [{ type: "percent", value: 10 }, { type: "fixed", value: 500 }]) → 8500
  3. Order: fixed then percent (different result) — applyDiscounts(10000, [{ type: "fixed", value: 500 }, { type: "percent", value: 10 }]) → 8550
  4. Clamp at zero — applyDiscounts(1000, [{ type: "fixed", value: 5000 }]) → 0
  5. Round half-up — applyDiscounts(999, [{ type: "percent", value: 10 }]) → 899
  6. Cap on total discount — applyDiscounts(10000, [{ type: "percent", value: 50 }, { type: "fixed", value: 3000 }], 4000) → 6000
  7. Empty discounts (identity) — applyDiscounts(10000, []) → 10000
  8. Negative subtotal — applyDiscounts(-1, [{ type: "fixed", value: 100 }]) → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/discount-stacking
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write an `applyDiscounts.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('applyDiscounts')`
block. The two order cases are the heart of the suite — same discounts, different
sequence, different price:

```typescript
it('applies discounts in order: percent then fixed', () => {
  const d = [{ type: 'percent', value: 10 }, { type: 'fixed', value: 500 }]
  expect(applyDiscounts(10000, d)).toBe(8500)
})

it('produces a different price when the order is reversed', () => {
  const d = [{ type: 'fixed', value: 500 }, { type: 'percent', value: 10 }]
  expect(applyDiscounts(10000, d)).toBe(8550)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/applyDiscounts.test.ts
```

The tests import an `applyDiscounts` stub — paste your real implementation or
point the import at your module before running.

## Variations to try

- **Order-invariance check:** ask Canary to assert that a list of *only* fixed
  discounts gives the same result in any order, while any list containing a
  percent does not — pins down exactly where order matters
- **Per-step cap:** switch the cap to clamp after each discount (so later
  discounts can't push the total past the cap mid-sequence) and watch case 6's
  expected value shift
- **Discount provenance:** return `{ finalCents, applied: Discount[] }` so the
  caller can see which discounts actually moved the price after the cap bound

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
