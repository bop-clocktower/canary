# Example: Bytes Humanizer

Tests a `humanize` function that formats a raw byte count as a human-readable
string like `"1.5 KiB"` — choosing the right unit, rounding to one decimal, and
handling the binary-vs-decimal split.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. Formatting
bytes looks like "divide and add a suffix" until you hit the two edges naïve
implementations get wrong: rounding can push a value *across* a unit boundary
(`999.95 kB` must become `"1.0 MB"`, not `"1000.0 kB"`), and `KiB` (1024) is not
`kB` (1000) — the same byte count formats differently depending on `opts.binary`.
The interesting surface is exactly those two: the unit-crossing round and the
base selection.

## Prompt

```text
Generate Vitest unit tests for a humanize function.

Signature:
    function humanize(bytes: number, opts: { binary: boolean }): string

The function formats a byte count as a human-readable string, choosing the
largest unit whose value is at least 1 and rounding to one decimal place.

How it works:
  - opts.binary selects the unit system:
      binary  -> base 1024, units B, KiB, MiB, GiB, TiB, PiB
      decimal -> base 1000, units B, kB, MB, GB, TB, PB
  - Below one unit (bytes < base) the result is the integer byte count followed
    by " B" — e.g. "512 B", "0 B" — with no decimal place.
  - At or above one unit, divide down to the largest unit below `base`, round
    the value half-up to one decimal place, and format as "<value> <unit>" —
    e.g. "1.5 KiB".
  - Unit-crossing on round: if rounding pushes the value up to `base`
    (e.g. 999.95 kB -> 1000.0), promote to the next unit as "1.0". So
    humanize(999950, { binary: false }) is "1.0 MB", not "1000.0 kB".
  - A negative or non-finite byte count throws a RangeError.

Cover these cases:
  1. Below one unit, plain bytes — humanize(512, { binary: true }) -> "512 B"
  2. Zero — humanize(0, { binary: true }) -> "0 B"
  3. Exact unit — humanize(1024, { binary: true }) -> "1.0 KiB"
  4. One decimal place — humanize(1536, { binary: true }) -> "1.5 KiB"
  5. Binary vs decimal diverge — humanize(1000, { binary: true }) -> "1000 B",
     humanize(1000, { binary: false }) -> "1.0 kB"
  6. Unit-crossing on round — humanize(999950, { binary: false }) -> "1.0 MB"
  7. Larger unit — humanize(5368709120, { binary: true }) -> "5.0 GiB"
  8. Negative byte count — humanize(-1, { binary: true }) -> throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/bytes-humanizer
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `humanize.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('humanize')`
block. The unit-crossing case is where naïve `Math.round` implementations break:

```typescript
it('promotes to the next unit when rounding crosses the boundary', () => {
  // 999.95 kB rounds to 1000.0, which is one whole MB — not "1000.0 kB"
  expect(humanize(999950, { binary: false })).toBe('1.0 MB')
})

it('treats KiB (1024) and kB (1000) as different units', () => {
  expect(humanize(1000, { binary: true })).toBe('1000 B')
  expect(humanize(1000, { binary: false })).toBe('1.0 kB')
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/humanize.test.ts
```

The tests import a `humanize` stub — paste your real implementation or point the
import at your module before running.

## Variations to try

- **Property check:** ask Canary to add a `fast-check` case asserting the output
  always matches `/^\d+(\.\d)? (B|KiB|MiB|GiB|TiB|PiB)$/` for any non-negative
  integer in binary mode — proves the format never degrades
- **Configurable precision:** add a `decimals: number` option (default 1) and
  assert `humanize(1536, { binary: true, decimals: 2 })` is `"1.50 KiB"`
- **Bits contrast:** ask for a sibling `humanizeBits` that uses bit units
  (`Kbit`, `Mbit`) and a test showing 1 byte = 8 bits — surfaces the
  bytes-vs-bits confusion that bites network code
- **Round-down contrast:** ask for an intentionally-broken version using
  `Math.floor` instead of round-half-up, and a test showing it mis-formats
  `1536` as `"1.5 KiB"` vs a value that floors wrong — makes the rounding rule
  concrete

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
