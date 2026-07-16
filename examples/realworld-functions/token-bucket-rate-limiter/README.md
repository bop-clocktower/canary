# Example: Token Bucket Rate Limiter

Tests an `allow` function implementing a continuous token-bucket rate
limiter — refill is a float function of elapsed time, not a discrete
per-tick counter.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. The
token bucket is the classic rate-limiting algorithm, and the trap is
treating it as discrete (`tokens++` per tick) instead of continuous
(`elapsed * refillRate`). This example threads `now` and `lastRefill`
through the state instead of reading the clock internally — the same
dependency-injection-of-time trick as `retry-backoff-schedule`'s injected
`rng`, applied to a different kind of nondeterminism. Case 2 chains two
calls to show the bucket draining exactly to empty, then denying.

## Prompt

```text
Generate Vitest unit tests for an allow function.

Signature:
    function allow(
        state: { tokens: number; lastRefill: number },
        now: number,
        capacity: number,
        refillRate: number,
    ): { allowed: boolean; newState: { tokens: number; lastRefill: number } }

The function implements a continuous token-bucket rate limiter. All of
`state.tokens`, `state.lastRefill`, `now`, `capacity`, and `refillRate` are
floats (no rounding, no discrete banking of leftover time).

Rules:
  - Refill first: elapsed = now - state.lastRefill; refilled tokens =
    min(capacity, state.tokens + elapsed * refillRate).
  - After refill, if tokens >= 1, the request is allowed and consumes exactly
    1 token; otherwise it is denied and no tokens are consumed.
  - newState always reflects the refilled tokens (post-consumption if
    allowed) and lastRefill: now.
  - capacity must be > 0, refillRate must be >= 0, and elapsed (now -
    state.lastRefill) must be >= 0 — any violation throws a RangeError.

Cover these cases:
  1. Fresh full bucket, one request allowed — allow({ tokens: 5, lastRefill: 1000 }, 1000, 5, 1) → { allowed: true, newState: { tokens: 4, lastRefill: 1000 } }
  2. Repeated draining until denied — allow({ tokens: 1, lastRefill: 1000 }, 1000, 5, 1) → { allowed: true, newState: { tokens: 0, lastRefill: 1000 } }; a second call with that newState, allow({ tokens: 0, lastRefill: 1000 }, 1000, 5, 1) → { allowed: false, newState: { tokens: 0, lastRefill: 1000 } }
  3. Refill after elapsed time restores tokens — allow({ tokens: 0, lastRefill: 1000 }, 1005, 5, 1) → { allowed: true, newState: { tokens: 4, lastRefill: 1005 } }
  4. Refill caps at capacity — allow({ tokens: 0, lastRefill: 1000 }, 1100, 5, 1) → { allowed: true, newState: { tokens: 4, lastRefill: 1100 } }
  5. Zero elapsed time, pure consume-check — allow({ tokens: 3, lastRefill: 1000 }, 1000, 5, 2) → { allowed: true, newState: { tokens: 2, lastRefill: 1000 } }
  6. Tokens exactly 1.0 → allowed, becomes 0.0 — allow({ tokens: 1.0, lastRefill: 0 }, 0, 10, 0.5) → { allowed: true, newState: { tokens: 0.0, lastRefill: 0 } }
  7. capacity <= 0 — allow({ tokens: 1, lastRefill: 0 }, 0, 0, 1) → throws RangeError
  8. Negative elapsed (clock skew, now < lastRefill) — allow({ tokens: 1, lastRefill: 1000 }, 900, 5, 1) → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/token-bucket-rate-limiter
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write an `allow.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases. The chained-call case is the clearest proof
that state, not a global clock, drives the bucket:

```typescript
it('denies once tokens are exhausted', () => {
  const drained = allow({ tokens: 1, lastRefill: 1000 }, 1000, 5, 1)
  expect(drained).toEqual({ allowed: true, newState: { tokens: 0, lastRefill: 1000 } })

  const denied = allow(drained.newState, 1000, 5, 1)
  expect(denied).toEqual({ allowed: false, newState: { tokens: 0, lastRefill: 1000 } })
})

it('rejects a negative elapsed time as clock skew', () => {
  expect(() => allow({ tokens: 1, lastRefill: 1000 }, 900, 5, 1)).toThrow(RangeError)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/allow.test.ts
```

The tests import an `allow` stub — paste your real implementation or point
the import at your module before running.

## Variations to try

- **Burst property:** ask Canary for a test asserting `newState.tokens`
  never exceeds `capacity` and never goes negative across a randomized
  sequence of calls — the headline invariant, proven rather than
  spot-checked
- **Weighted cost:** change consumption to an explicit `cost: number`
  parameter (default 1) and ask for tests where a single request can drain
  multiple tokens at once
- **Multi-tenant buckets:** wrap `allow` in a `Map<string, State>` keyed by
  client id and ask for a test proving one client's draining doesn't affect
  another's

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
