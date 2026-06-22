# Example: Price Normalizer

Tests a `normalizePrice` function that parses mixed-format price strings
(US, European, bare numbers, multiple currency symbols) into a canonical
`{ amount, currency }` object, returning `null` for anything unparseable.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures.
The interesting surface is the parsing edge cases: European vs. US decimal
formats, whitespace tolerance, and clean rejection of invalid input.

## Prompt

```text
Generate Vitest unit tests for a normalizePrice function.

Signature:
    function normalizePrice(raw: string): { amount: number; currency: string } | null

The function parses a raw price string into a canonical object where `amount`
is a floating-point number in the major currency unit (dollars, euros, pounds —
not cents) and `currency` is the ISO 4217 code. Returns null for any input it
cannot parse.

Parsing rules:
  - Leading currency symbols map to ISO codes: $ → USD, € → EUR, £ → GBP, ¥ → JPY
  - European decimal format (period as thousands separator, comma as decimal):
    "1.299,99" → 1299.99
  - US/UK decimal format (comma as thousands separator, period as decimal):
    "1,299.99" → 1299.99
  - No symbol defaults to USD
  - Whitespace between symbol and digits is allowed: "$ 9.99"

Cover these cases:
  1. US format with symbol — "$1,299.99" → { amount: 1299.99, currency: "USD" }
  2. European format with symbol — "€1.299,99" → { amount: 1299.99, currency: "EUR" }
  3. No symbol, plain number — "1299" → { amount: 1299, currency: "USD" }
  4. Pounds, pence — "£0.99" → { amount: 0.99, currency: "GBP" }
  5. Whitespace between symbol and digits — "$ 9.99" → { amount: 9.99, currency: "USD" }
  6. Negative value — "-$5.00" → null
  7. Empty string — "" → null
  8. Non-numeric input — "free" → null
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/price-normalizer
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `normalizePrice.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('normalizePrice')`
block. Rough shape for the two trickiest cases:

```typescript
it('parses European decimal format', () => {
  expect(normalizePrice('€1.299,99')).toEqual({ amount: 1299.99, currency: 'EUR' })
})

it('returns null for negative values', () => {
  expect(normalizePrice('-$5.00')).toBeNull()
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/normalizePrice.test.ts
```

The tests import a `normalizePrice` stub — paste your real implementation
or point the import at your module before running.

## Variations to try

- **Stricter:** ask Canary to also cover `¥1,000` (no decimal) and
  `"CHF 19.90"` (symbol as prefix word, not a single char)
- **Parametrized:** ask for a `test.each` table instead of individual cases
- **Error detail:** extend the null cases to return `{ error: string }`
  instead of `null` — update the prompt signature accordingly

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
