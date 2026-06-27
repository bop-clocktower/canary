# Example: Feature-Flag Bucketing

Tests a `bucket` function that decides whether a user is in a gradual percentage
rollout of a feature flag — a deterministic, stateless hash assignment where
**raising the rollout percentage never un-enrolls anyone**.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. Bucketing
looks like "compute a percentage and compare" until you notice the two edges
naïve implementations get wrong: a user whose bucket is exactly `75` is **not**
enrolled at `75%` (the comparison is `<`, not `<=`), and the assignment must be
*stable* — `Math.random()` would re-roll every call and silently break the
monotonic-rollout guarantee. The interesting surface is that guarantee: enroll
a user at 50% and they stay enrolled at 60%, 75%, 100% — enrollment only ever
turns on as the percentage climbs.

## Prompt

```text
Generate Vitest unit tests for a feature-flag bucket function.

Signature:
    function bucket(userId: string, flagKey: string, percentage: number): boolean

The function decides whether a user is enrolled in a gradual percentage rollout
of a feature flag. The decision is deterministic and stable: the same inputs
always return the same result, with no stored state.

How it works:
  - Hash the string `${userId}:${flagKey}` with 32-bit FNV-1a:
      offset basis = 2166136261, prime = 16777619, arithmetic mod 2^32,
      hashing the UTF-8 bytes of the string.
  - The user's bucket is `hash % 100` (an integer 0..99).
  - The user is enrolled when `bucket < percentage`.
  - `percentage` is an integer 0..100. Values outside that range throw a
    RangeError.

Invariants:
  - Deterministic: bucket(u, f, p) always equals bucket(u, f, p).
  - Monotonic rollout: for a fixed (userId, flagKey), if the user is enrolled at
    percentage p, they are enrolled at every q >= p. Raising the rollout never
    un-enrolls anyone.
  - 0% enrolls nobody; 100% enrolls everybody.
  - flagKey is part of the hashed key, so the same user is bucketed
    independently per flag.

Cover these cases (bucket('user-42','checkout') = 75; bucket('alice','checkout') = 35):
  1. Deterministic — bucket('user-42', 'checkout', 50) called twice → false both times
  2. 0% enrolls nobody — bucket('alice', 'checkout', 0) → false
  3. 100% enrolls everybody — bucket('user-42', 'checkout', 100) → true
  4. Below threshold, enrolled — bucket('alice', 'checkout', 50) → true
  5. Own bucket does NOT enroll (`<`, not `<=`) — bucket('user-42', 'checkout', 75) → false,
     bucket('user-42', 'checkout', 76) → true
  6. Monotonic rollout — bucket('alice', 'checkout', 30) → false, then 50 → true, 75 → true
  7. Per-flag independence — bucket('user-42', 'checkout', 50) → false but
     bucket('user-42', 'beta', 50) → true
  8. Out-of-range percentage — bucket('alice', 'checkout', -1) and (…, 101) → throws RangeError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/feature-flag-bucketing
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `bucket.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases, likely grouped into a `describe('bucket')` block.
The boundary case and the monotonic-rollout invariant are where naïve
implementations break:

```typescript
it('does not enroll a user at their own bucket number', () => {
  // bucket('user-42', 'checkout') === 75, and the comparison is `<`, not `<=`
  expect(bucket('user-42', 'checkout', 75)).toBe(false)
  expect(bucket('user-42', 'checkout', 76)).toBe(true)
})

it('never un-enrolls a user as the rollout grows', () => {
  expect(bucket('alice', 'checkout', 30)).toBe(false)
  expect(bucket('alice', 'checkout', 50)).toBe(true)
  expect(bucket('alice', 'checkout', 75)).toBe(true)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/bucket.test.ts
```

The tests import a `bucket` stub — paste your real implementation or point the
import at your module before running.

## Variations to try

- **Property check:** ask Canary to add a `fast-check` (or `test.each`) case
  asserting monotonicity across random inputs — for any `userId`, `flagKey`, and
  `p <= q`, `bucket(u, f, p)` implies `bucket(u, f, q)`. The monotonic-rollout
  guarantee is the whole point, so prove it holds broadly
- **Distribution:** ask for a test that buckets 10,000 synthetic ids at `40%`
  and asserts the enrolled fraction is roughly `0.40` (±a few points) — shows the
  hash spreads users evenly
- **`Math.random()` contrast:** ask for a second, intentionally-broken
  implementation that rolls `Math.random() * 100` instead of hashing, and a test
  showing it fails the deterministic and monotonic cases — makes concrete *why*
  the assignment must be a pure function of the inputs
- **Sticky bucketing across flags:** change the signature to
  `bucket(userId, flagKey, rollout: Record<string, number>)` so one call resolves
  many flags at once, and assert each flag enrolls independently

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
