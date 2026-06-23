# Example: Retry Backoff Schedule

Tests a `backoffDelays` function that produces an exponential-backoff retry
schedule with **full jitter**, where the random source is **injected** as a
parameter.

This is a **TypeScript unit** example. Retry jitter is randomness, and randomness
is where "just test it" usually gives up — a function that calls `Math.random()`
internally can only be tested loosely. The whole point of this example is the
opposite: by taking `rng: () => number` as an argument, the schedule becomes
**fully deterministic under test**. Pass `() => 0` to assert the lower bound,
`() => 0.5` for the midpoint, and a scripted sequence to assert exact per-attempt
delays. It teaches dependency-injection of nondeterminism — a testing skill the
other examples don't cover.

## Prompt

```text
Generate Vitest unit tests for a backoffDelays function.

Signature:
    function backoffDelays(
        attempts: number,
        baseMs: number,
        capMs: number,
        rng: () => number,
    ): number[]

The function returns the delay sequence for retrying an operation with
exponential backoff and full jitter. `rng` is an injected random source
returning a float in [0, 1) — passing it in (rather than calling Math.random
internally) is what makes the schedule deterministic under test.

Schedule rules:
  - Return exactly `attempts` delays. For the 0-indexed attempt i, the ceiling is
    min(capMs, baseMs * 2^i), and the delay is rng() * ceiling (full jitter).
  - rng() is called once per attempt, in order.
  - Each delay lies in [0, min(capMs, baseMs * 2^i)).
  - attempts === 0 returns an empty array (rng is never called).
  - Negative attempts, baseMs, or capMs throw a RangeError.

Cover these cases (the rng values are chosen so the expected output is exact):
  1. Zero attempts — backoffDelays(0, 100, 1000, () => 0.5) → []
  2. Floor (rng → 0) — backoffDelays(4, 100, 1000, () => 0) → [0, 0, 0, 0]
  3. Half jitter (rng → 0.5) — backoffDelays(4, 100, 1000, () => 0.5) → [50, 100, 200, 400]
  4. Cap clamps the exponential — backoffDelays(4, 100, 300, () => 0.5) → [50, 100, 150, 150]
  5. Scripted rng, exact per-attempt delays — rng yields 0, 0.25, 0.5, 0.75 in turn:
     backoffDelays(4, 100, 10000, scriptedRng) → [0, 50, 200, 600]
  6. Zero base — backoffDelays(3, 0, 1000, () => 0.9) → [0, 0, 0]
  7. Single attempt — backoffDelays(1, 100, 1000, () => 0.5) → [50]
  8. Negative attempts — backoffDelays(-1, 100, 1000, () => 0.5) → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/retry-backoff-schedule
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `backoffDelays.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases. The interesting ones drive the function with a
controlled `rng` so the assertions are exact, not approximate — the scripted-rng
case is the clearest demonstration of testing randomness deterministically:

```typescript
it('uses each rng value for the matching attempt', () => {
  const seq = [0, 0.25, 0.5, 0.75]
  let i = 0
  const rng = () => seq[i++]
  expect(backoffDelays(4, 100, 10000, rng)).toEqual([0, 50, 200, 600])
})

it('clamps the exponential at the cap', () => {
  expect(backoffDelays(4, 100, 300, () => 0.5)).toEqual([50, 100, 150, 150])
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/backoffDelays.test.ts
```

The tests import a `backoffDelays` stub — paste your real implementation or point
the import at your module before running.

## Variations to try

- **Bounds property:** ask Canary to add a `test.each` asserting every delay sits
  in `[0, min(cap, base * 2^i))` for random `rng` values — the bound holds no
  matter what the source returns
- **Equal jitter:** switch the rule to `delay = h + rng() * h` where
  `h = min(cap, base * 2^i) / 2`, and watch the expected values shift
- **Call-count assertion:** wrap `rng` in a spy and assert it's called exactly
  `attempts` times — proves the schedule consumes randomness once per attempt

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
