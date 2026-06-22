# Example: Interval Merger

Tests a `mergeIntervals` function that collapses overlapping and adjacent
`[start, end]` ranges into the smallest set of non-overlapping intervals,
sorted ascending.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures.
Interval merging is a deceptively simple algorithm whose bugs hide at the
boundaries: do *touching* intervals merge? Is a fully nested range absorbed?
Is unsorted input handled? The prompt pins all of those down so the generated
suite tests the contract, not just two clearly-overlapping ranges.

## Prompt

```text
Generate Vitest unit tests for a mergeIntervals function.

Signature:
    function mergeIntervals(intervals: [number, number][]): [number, number][]

The function merges overlapping and adjacent intervals into the smallest set
of non-overlapping intervals, sorted ascending by start. Each input interval
is a [start, end] pair with start <= end.

Merging rules:
  - Two intervals overlap if they share any point. They merge into one
    interval spanning [min(starts), max(ends)].
  - Adjacent (touching) intervals merge too: the end of one equals the start
    of the next, e.g. [1, 2] and [2, 3] → [1, 3].
  - A fully nested interval is absorbed by its container: [3, 4] inside
    [1, 10] → [1, 10].
  - Input may be unsorted; output is always sorted ascending by start.
  - An empty input returns an empty array.
  - An interval with start > end is invalid: throw a RangeError.

Cover these cases:
  1. Empty input — [] → []
  2. Single interval — [[1, 3]] → [[1, 3]]
  3. Two overlapping — [[1, 3], [2, 4]] → [[1, 4]]
  4. Two adjacent (touching) — [[1, 2], [2, 3]] → [[1, 3]]
  5. Two disjoint, unsorted — [[5, 6], [1, 2]] → [[1, 2], [5, 6]]
  6. Fully nested — [[1, 10], [3, 4]] → [[1, 10]]
  7. Unsorted, mixed overlap — [[1, 4], [8, 10], [2, 3], [9, 12]] → [[1, 4], [8, 12]]
  8. Invalid interval (start > end) — [[5, 2]] → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/interval-merger
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `mergeIntervals.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('mergeIntervals')`
block. The touching-interval and invalid-input cases are where most
implementations slip:

```typescript
it('merges adjacent (touching) intervals', () => {
  expect(mergeIntervals([[1, 2], [2, 3]])).toEqual([[1, 3]])
})

it('throws on an interval with start > end', () => {
  expect(() => mergeIntervals([[5, 2]])).toThrow(RangeError)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/mergeIntervals.test.ts
```

The tests import a `mergeIntervals` stub — paste your real implementation
or point the import at your module before running.

## Variations to try

- **Open vs. closed intervals:** ask Canary to treat touching intervals as
  *non*-merging ([1, 2] and [2, 3] stay separate) and watch the boundary
  cases flip — useful for half-open `[start, end)` semantics
- **Payload preservation:** change intervals to `{ start, end, label }` and
  ask that merged intervals concatenate their labels
- **Parametrized:** ask for a `test.each` table driven by the eight rows above
  instead of individual cases

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
