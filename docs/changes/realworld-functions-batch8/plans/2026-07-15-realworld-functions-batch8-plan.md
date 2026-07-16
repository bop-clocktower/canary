# Plan: Real-World Function Examples — Batch 8

<!-- markdownlint-disable-file MD013 MD032 -->
<!-- Generated implementation plan: task steps mix long prose/command lines
     with label-then-list blocks (**Files:** followed by a list), matching the
     canary-fail-fast plan's MD013/MD032 relaxation for working docs. The
     example files this plan produces (prompt.txt, README.md) are NOT exempt
     — they must pass markdownlint/MD013 (80 cols) on their own, per Task 5. -->

**Date:** 2026-07-15 | **Spec:** `docs/changes/realworld-functions-batch8/proposal.md` | **Tasks:** 6 | **Time:** ~35 min | **Integration Tier:** small

## Goal

Add three new prompt-only example directories
(`pagination-cursor-codec`, `business-hours-deadline`,
`token-bucket-rate-limiter`) to `examples/realworld-functions/`, each with a
template-faithful `prompt.txt` + `README.md`, cataloged in both README tables,
verified green by the existing structural test and markdownlint.

This is **not** a TDD code-writing task. There is no application code to
implement or unit-test — the deliverable is prompt/doc content, and the only
"tests" involved are the repo's own structural guard
(`tests/unit/test_examples_catalog.py`) and markdownlint, both of which
already exist and are run unmodified in Task 5.

## Observable Truths (Acceptance Criteria)

1. `examples/realworld-functions/pagination-cursor-codec/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases matching the
   spec's Technical Design section.
2. `examples/realworld-functions/business-hours-deadline/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases.
3. `examples/realworld-functions/token-bucket-rate-limiter/prompt.txt` and
   `README.md` exist; the prompt has exactly 8 numbered cases.
4. Both `examples/realworld-functions/README.md` and `examples/README.md`
   list all three new examples in their catalog tables.
5. `uv run pytest tests/unit/test_examples_catalog.py -v` passes (all
   subtests green, including the three new example dirs).
6. `npx --no markdownlint-cli` passes on all 5 new/changed `.md` files.
7. The catalog's framework mix after this batch is 7 pytest / 10 vitest (17
   total) — matching the spec's stated success criterion.

## Uncertainties

- [ASSUMPTION] The spec pins `RangeError` for `encodeCursor`'s non-integer
  input (case 7) but does not state an error type for `decodeCursor`'s four
  failure cases (tampered / malformed base64 / empty / truncated — cases
  3-6). This plan uses `RangeError` for all of them, for consistency within
  the single `encodeCursor`/`decodeCursor` pair (one error type per module,
  matching this catalog's convention of pinning a single error class per
  example — see `interval-merger`, `money-allocator`, `discount-stacking`).
  If wrong, only Task 1's `prompt.txt` content changes.
- [ASSUMPTION] `token-bucket-rate-limiter`'s `newState.lastRefill` is always
  set to `now` (whether or not the request is allowed) — this is the
  standard token-bucket update rule and isn't contradicted by the spec, but
  isn't spelled out either. If wrong, only Task 3's `prompt.txt` content
  changes.
- [DEFERRABLE] Exact generated test file names Canary would pick
  (`tests/generated/*.test.ts` / `test_*.py`) in each README's "What Canary
  should produce" section are illustrative only — not verified by any test,
  cosmetic if off.

## File Map

- CREATE `examples/realworld-functions/pagination-cursor-codec/prompt.txt`
- CREATE `examples/realworld-functions/pagination-cursor-codec/README.md`
- CREATE `examples/realworld-functions/business-hours-deadline/prompt.txt`
- CREATE `examples/realworld-functions/business-hours-deadline/README.md`
- CREATE `examples/realworld-functions/token-bucket-rate-limiter/prompt.txt`
- CREATE `examples/realworld-functions/token-bucket-rate-limiter/README.md`
- MODIFY `examples/realworld-functions/README.md` (3 catalog rows)
- MODIFY `examples/README.md` (3 catalog rows)

## Skeleton

_Not produced — task count (6) is below the standard-rigor threshold (8)._

## Tasks

### Task 1: Create `pagination-cursor-codec/` (prompt.txt + README.md)

**Depends on:** none | **Files:** `examples/realworld-functions/pagination-cursor-codec/prompt.txt`, `examples/realworld-functions/pagination-cursor-codec/README.md`

- [ ] **Step 1:** Create `examples/realworld-functions/pagination-cursor-codec/prompt.txt`:

```text
Generate Vitest unit tests for encodeCursor and decodeCursor functions.

Signature:
    function encodeCursor(state: { id: number; createdAt: number }): string
    function decodeCursor(cursor: string): { id: number; createdAt: number }

encodeCursor JSON-serializes `state`, appends a checksum, and base64url-encodes
the result into an opaque pagination cursor. decodeCursor reverses this: it
base64url-decodes the cursor, verifies the checksum, and returns the original
state — rejecting any tampered or malformed input.

Rules:
  - `id` and `createdAt` must both be integers (Number.isInteger). encodeCursor
    throws a RangeError if either is not an integer.
  - decodeCursor throws a RangeError if the checksum does not match (tampered
    payload), if the input is not valid base64url, if the input is empty, or
    if the decoded payload is too short to contain both a state and a checksum
    (truncated cursor).
  - decodeCursor(encodeCursor(state)) returns a value deep-equal to the
    original state for every valid integer-keyed input.

Cover these cases:
  1. Round-trip preserves exact state — decodeCursor(encodeCursor({ id: 42, createdAt: 1700000000000 })) → { id: 42, createdAt: 1700000000000 }
  2. Round-trip with id: 0 — decodeCursor(encodeCursor({ id: 0, createdAt: 1700000000000 })) → { id: 0, createdAt: 1700000000000 }
  3. Tampered payload — flip one character of a valid encodeCursor(...) output → decodeCursor throws RangeError
  4. Malformed base64 — decodeCursor("not-valid-base64!!!") → throws RangeError
  5. Empty string — decodeCursor("") → throws RangeError
  6. Truncated cursor — a syntactically valid base64url string too short to contain a payload plus checksum → decodeCursor throws RangeError
  7. Non-integer id/createdAt at encode time — encodeCursor({ id: 1.5, createdAt: 1700000000000 }) → throws RangeError
  8. Number.MAX_SAFE_INTEGER values round-trip — decodeCursor(encodeCursor({ id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER })) → { id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
```

- [ ] **Step 2:** Create `examples/realworld-functions/pagination-cursor-codec/README.md`.
   NOTE: this block uses a 4-backtick outer fence (` ```` `) because the
   README content itself contains nested triple-backtick fences (the
   `text`/`typescript`/`bash` blocks below) — do not write the 4-backtick
   markers into the actual file, they exist only to delimit this plan step.

````markdown
# Example: Pagination Cursor Codec

Tests a paired `encodeCursor` / `decodeCursor` that serialize pagination
state into an opaque, tamper-evident cursor string.

This is a **TypeScript unit** example — no HTTP, no DOM, no fixtures. A
pagination cursor looks trivial — just base64-encode the state — until a
client edits the string. This example pins a checksum into the cursor so
`decodeCursor` can prove the payload wasn't tampered with, and pins `id` /
`createdAt` to integers (rather than a generic `Record<string, unknown>`)
so the contract stays testable. The tamper case (3) is the whole point:
most naive cursor implementations skip integrity checking entirely.

## Prompt

```text
Generate Vitest unit tests for encodeCursor and decodeCursor functions.

Signature:
    function encodeCursor(state: { id: number; createdAt: number }): string
    function decodeCursor(cursor: string): { id: number; createdAt: number }

encodeCursor JSON-serializes `state`, appends a checksum, and base64url-encodes
the result into an opaque pagination cursor. decodeCursor reverses this: it
base64url-decodes the cursor, verifies the checksum, and returns the original
state — rejecting any tampered or malformed input.

Rules:
  - `id` and `createdAt` must both be integers (Number.isInteger). encodeCursor
    throws a RangeError if either is not an integer.
  - decodeCursor throws a RangeError if the checksum does not match (tampered
    payload), if the input is not valid base64url, if the input is empty, or
    if the decoded payload is too short to contain both a state and a checksum
    (truncated cursor).
  - decodeCursor(encodeCursor(state)) returns a value deep-equal to the
    original state for every valid integer-keyed input.

Cover these cases:
  1. Round-trip preserves exact state — decodeCursor(encodeCursor({ id: 42, createdAt: 1700000000000 })) → { id: 42, createdAt: 1700000000000 }
  2. Round-trip with id: 0 — decodeCursor(encodeCursor({ id: 0, createdAt: 1700000000000 })) → { id: 0, createdAt: 1700000000000 }
  3. Tampered payload — flip one character of a valid encodeCursor(...) output → decodeCursor throws RangeError
  4. Malformed base64 — decodeCursor("not-valid-base64!!!") → throws RangeError
  5. Empty string — decodeCursor("") → throws RangeError
  6. Truncated cursor — a syntactically valid base64url string too short to contain a payload plus checksum → decodeCursor throws RangeError
  7. Non-integer id/createdAt at encode time — encodeCursor({ id: 1.5, createdAt: 1700000000000 }) → throws RangeError
  8. Number.MAX_SAFE_INTEGER values round-trip — decodeCursor(encodeCursor({ id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER })) → { id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/pagination-cursor-codec
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `frontend_unit` (Vitest hint)
2. Pick `vitest` from the framework registry
3. Write a `paginationCursorCodec.test.ts` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight `it()` / `test()` cases. The tamper case is the one that proves the
checksum is load-bearing, not decorative:

```typescript
it('rejects a tampered cursor', () => {
  const cursor = encodeCursor({ id: 42, createdAt: 1700000000000 })
  const tampered = cursor.slice(0, -1) + (cursor.at(-1) === 'A' ? 'B' : 'A')
  expect(() => decodeCursor(tampered)).toThrow(RangeError)
})

it('round-trips Number.MAX_SAFE_INTEGER values', () => {
  const state = { id: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
  expect(decodeCursor(encodeCursor(state))).toEqual(state)
})
```

## Running the generated test

```bash
npm install -D vitest
npx vitest run tests/generated/paginationCursorCodec.test.ts
```

The tests import `encodeCursor`/`decodeCursor` stubs — paste your real
implementation or point the import at your module before running.

## Variations to try

- **Property check:** ask Canary for a test asserting
  `decodeCursor(encodeCursor(s))` round-trips across a table of random
  integer `id`/`createdAt` pairs, including negative and large values
- **Multi-byte tamper:** extend case 3 to flip a byte in the middle of the
  payload rather than the last character, and confirm the checksum still
  catches it
- **Versioned cursor:** add a `version` byte to the encoded payload and ask
  Canary for a test that rejects cursors from a future/unknown version

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
````

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `feat(examples): add pagination-cursor-codec realworld example`

### Task 2: Create `business-hours-deadline/` (prompt.txt + README.md)

**Depends on:** none | **Files:** `examples/realworld-functions/business-hours-deadline/prompt.txt`, `examples/realworld-functions/business-hours-deadline/README.md`

- [ ] **Step 1:** Create `examples/realworld-functions/business-hours-deadline/prompt.txt`:

```text
Generate pytest unit tests for an add_business_hours function.

Signature:
    from datetime import date, datetime

    def add_business_hours(
        start: datetime,
        hours: int,
        holidays: set[date],
    ) -> datetime:

The function adds a budget of business hours to `start` and returns the
resulting datetime (UTC). The business window is fixed: 09:00-17:00 UTC,
Monday-Friday, minus any date present in `holidays`.

Rules:
  - `hours` must be a non-negative int. A float or negative value raises a
    ValueError.
  - If `start` falls outside the business window (before 09:00, after 17:00,
    on a weekend, or on a holiday), it first rounds up to the next valid
    window-start (09:00 on the next business day) before consuming any of the
    `hours` budget.
  - Hours are consumed by walking forward through business windows in order,
    skipping weekends and holidays entirely — each business day contributes
    exactly 8 business-hours.

Cover these cases (all datetimes are UTC; 2024-01-01 is a Monday):
  1. Same-day addition, no skip — add_business_hours(datetime(2024, 1, 1, 10, 0), 3, set()) → datetime(2024, 1, 1, 13, 0)
  2. Crosses end-of-day, rolls to next business day — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, set()) → datetime(2024, 1, 2, 11, 0)
  3. Crosses a weekend — add_business_hours(datetime(2024, 1, 5, 15, 0), 4, set()) → datetime(2024, 1, 8, 11, 0)
  4. Crosses an explicit holiday — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, {date(2024, 1, 2)}) → datetime(2024, 1, 3, 11, 0)
  5. start outside business hours rounds up first — add_business_hours(datetime(2024, 1, 1, 20, 0), 1, set()) → datetime(2024, 1, 2, 10, 0)
  6. hours=0 — add_business_hours(datetime(2024, 1, 1, 10, 0), 0, set()) → datetime(2024, 1, 1, 10, 0) (already in-window, unchanged); add_business_hours(datetime(2024, 1, 1, 20, 0), 0, set()) → datetime(2024, 1, 2, 9, 0) (outside window, rounds up only)
  7. Multi-day span, full 8-hour days — add_business_hours(datetime(2024, 1, 1, 9, 0), 20, set()) → datetime(2024, 1, 3, 13, 0)
  8. Negative hours — add_business_hours(datetime(2024, 1, 1, 10, 0), -1, set()) → raises ValueError
```

- [ ] **Step 2:** Create `examples/realworld-functions/business-hours-deadline/README.md`.
   NOTE: 4-backtick outer fence for the same nesting reason as Task 1.

````markdown
# Example: Business Hours Deadline

Tests an `add_business_hours` function that adds a budget of business hours
to a start time, skipping nights, weekends, and holidays.

This is a **Python unit** example. Two edges trip up naive implementations:
a start time **outside** the business window must round up before any hours
are consumed, and `hours=0` must still perform that rounding — it isn't
simply a no-op (case 6 asserts both branches). Fixing the window to
09:00-17:00 UTC, Monday-Friday keeps the DST/timezone rabbit hole out of
scope entirely.

## Prompt

```text
Generate pytest unit tests for an add_business_hours function.

Signature:
    from datetime import date, datetime

    def add_business_hours(
        start: datetime,
        hours: int,
        holidays: set[date],
    ) -> datetime:

The function adds a budget of business hours to `start` and returns the
resulting datetime (UTC). The business window is fixed: 09:00-17:00 UTC,
Monday-Friday, minus any date present in `holidays`.

Rules:
  - `hours` must be a non-negative int. A float or negative value raises a
    ValueError.
  - If `start` falls outside the business window (before 09:00, after 17:00,
    on a weekend, or on a holiday), it first rounds up to the next valid
    window-start (09:00 on the next business day) before consuming any of the
    `hours` budget.
  - Hours are consumed by walking forward through business windows in order,
    skipping weekends and holidays entirely — each business day contributes
    exactly 8 business-hours.

Cover these cases (all datetimes are UTC; 2024-01-01 is a Monday):
  1. Same-day addition, no skip — add_business_hours(datetime(2024, 1, 1, 10, 0), 3, set()) → datetime(2024, 1, 1, 13, 0)
  2. Crosses end-of-day, rolls to next business day — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, set()) → datetime(2024, 1, 2, 11, 0)
  3. Crosses a weekend — add_business_hours(datetime(2024, 1, 5, 15, 0), 4, set()) → datetime(2024, 1, 8, 11, 0)
  4. Crosses an explicit holiday — add_business_hours(datetime(2024, 1, 1, 15, 0), 4, {date(2024, 1, 2)}) → datetime(2024, 1, 3, 11, 0)
  5. start outside business hours rounds up first — add_business_hours(datetime(2024, 1, 1, 20, 0), 1, set()) → datetime(2024, 1, 2, 10, 0)
  6. hours=0 — add_business_hours(datetime(2024, 1, 1, 10, 0), 0, set()) → datetime(2024, 1, 1, 10, 0) (already in-window, unchanged); add_business_hours(datetime(2024, 1, 1, 20, 0), 0, set()) → datetime(2024, 1, 2, 9, 0) (outside window, rounds up only)
  7. Multi-day span, full 8-hour days — add_business_hours(datetime(2024, 1, 1, 9, 0), 20, set()) → datetime(2024, 1, 3, 13, 0)
  8. Negative hours — add_business_hours(datetime(2024, 1, 1, 10, 0), -1, set()) → raises ValueError
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/realworld-functions/business-hours-deadline
cat prompt.txt
```

Then, in Claude Code, generate the test:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Canary will:

1. Classify the request as `python_unit` (pytest hint, pure datetime function)
2. Pick `pytest` from the framework registry
3. Write a `test_add_business_hours.py` file under `tests/generated/`
4. Print the file path + feedback hint

## What Canary should produce

Eight test functions covering the window-crossing and rounding rules. The
zero-hours case is the one most likely to be under-tested — it still has to
prove the rounding-up branch, not just the identity branch:

```python
def test_zero_hours_outside_window_rounds_up_only():
    result = add_business_hours(datetime(2024, 1, 1, 20, 0), 0, set())
    assert result == datetime(2024, 1, 2, 9, 0)

def test_crosses_explicit_holiday():
    result = add_business_hours(
        datetime(2024, 1, 1, 15, 0), 4, {date(2024, 1, 2)}
    )
    assert result == datetime(2024, 1, 3, 11, 0)
```

## Running the generated test

```bash
pip install pytest
pytest tests/generated/test_add_business_hours.py -v
```

## Variations to try

- **Half-day holidays:** extend `holidays` to a dict of partial closures
  (e.g., 09:00-13:00 only) and ask Canary for tests that consume a reduced
  daily budget
- **Timezone-aware input:** accept a timezone-aware `start`, convert to UTC
  before applying the window, and ask for a test asserting a non-UTC input
  still lands on the right UTC hour
- **Business-days-only variant:** ask for a sibling `add_business_days` that
  skips the hour math entirely and just counts whole days

## See also

- [Getting Started → generating tests](../../../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../../../docs/wiki/Writing-Good-Prompts.md)
- [Real-world functions overview](../README.md)
````

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `feat(examples): add business-hours-deadline realworld example`

### Task 3: Create `token-bucket-rate-limiter/` (prompt.txt + README.md)

**Depends on:** none | **Files:** `examples/realworld-functions/token-bucket-rate-limiter/prompt.txt`, `examples/realworld-functions/token-bucket-rate-limiter/README.md`

- [ ] **Step 1:** Create `examples/realworld-functions/token-bucket-rate-limiter/prompt.txt`:

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

- [ ] **Step 2:** Create `examples/realworld-functions/token-bucket-rate-limiter/README.md`.
   NOTE: 4-backtick outer fence for the same nesting reason as Task 1.

````markdown
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
````

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `feat(examples): add token-bucket-rate-limiter realworld example`

### Task 4: Add catalog rows to both README.md files

**Depends on:** Task 1, Task 2, Task 3 | **Files:** `examples/realworld-functions/README.md`, `examples/README.md` | **Category:** integration

- [ ] **Step 1:** In `examples/realworld-functions/README.md`, append three rows to the
   `## Catalog` table (after the `bytes-humanizer` row, before the `## How
   these differ from the top-level examples` heading):

```markdown
| [pagination-cursor-codec](pagination-cursor-codec/) | Unit | Vitest | Tamper-evident pagination cursor — checksum round-trip, integer-only state |
| [business-hours-deadline](business-hours-deadline/) | Unit | Pytest | Add business hours across nights/weekends/holidays, round-up-first rounding |
| [token-bucket-rate-limiter](token-bucket-rate-limiter/) | Unit | Vitest | Continuous token-bucket refill — injected clock, capacity cap, clock-skew reject |
```

- [ ] **Step 2:** In `examples/README.md`, append the same three rows (with the
   `realworld-functions/` path prefix) to the `## Real-world function
   examples` table (after the `bytes-humanizer` row, before the "See
   [realworld-functions/README.md]..." line):

```markdown
| [pagination-cursor-codec](realworld-functions/pagination-cursor-codec/) | Unit | Vitest | Tamper-evident pagination cursor — checksum round-trip, integer-only state |
| [business-hours-deadline](realworld-functions/business-hours-deadline/) | Unit | Pytest | Add business hours across nights/weekends/holidays, round-up-first rounding |
| [token-bucket-rate-limiter](realworld-functions/token-bucket-rate-limiter/) | Unit | Vitest | Continuous token-bucket refill — injected clock, capacity cap, clock-skew reject |
```

- [ ] **Step 3:** Run: `harness validate`
- [ ] **Step 4:** Commit: `docs(examples): catalog realworld-functions batch 8`

### Task 5: Verify — structural test + markdownlint

**Depends on:** Task 4 | **Files:** none (verification only)

- [ ] **Step 1:** Run the structural catalog test:

```bash
uv run pytest tests/unit/test_examples_catalog.py -v
```

   Expect: all subtests pass, including
   `test_each_example_has_prompt_txt`, `test_each_example_has_readme`, and
   `test_each_example_linked_in_catalog` for all three new directories.

- [ ] **Step 2:** Run markdownlint on the 5 new/changed markdown files:

```bash
npx --no markdownlint-cli \
  examples/realworld-functions/pagination-cursor-codec/README.md \
  examples/realworld-functions/business-hours-deadline/README.md \
  examples/realworld-functions/token-bucket-rate-limiter/README.md \
  examples/realworld-functions/README.md \
  examples/README.md
```

   Expect: no output, exit code 0. If MD013 (line length) fires on any
   prose line, rewrap that line in the offending file only — table rows and
   fenced code blocks are exempt per `.markdownlint.json`.

- [ ] **Step 3:** Manually confirm the framework mix: count `Vitest` vs `Pytest` rows in
   `examples/realworld-functions/README.md` — expect 10 vitest / 7 pytest
   (17 total), matching the spec's stated success criterion.

- [ ] **Step 4:** If either check fails, fix the specific file and re-run both commands —
   do not proceed to Task 6 until both are green.

### Task 6: Commit remaining changes and open PR

**Depends on:** Task 5 | **Files:** none (git operations only)

- [ ] **Step 1:** Confirm branch: `git branch --show-current` → `feat/realworld-functions-batch8`
   (already checked out; no new branch needed).
- [ ] **Step 2:** Confirm all changes from Tasks 1-4 are committed:

```bash
git status
git log --oneline -5
```

- [ ] **Step 3:** Push the branch and open the PR:

```bash
git push -u origin feat/realworld-functions-batch8
gh pr create --title "feat(examples): add realworld-functions batch 8" --body "$(cat <<'EOF'
## Summary
- Adds three prompt-only examples to examples/realworld-functions/:
  pagination-cursor-codec (vitest), business-hours-deadline (pytest),
  token-bucket-rate-limiter (vitest)
- Catalogs all three in both examples/realworld-functions/README.md and
  examples/README.md
- Selected from the leftover ranked pool in
  docs/ideation/realworld-function-batch6-2026-06-27.md; spec at
  docs/changes/realworld-functions-batch8/proposal.md

## Test plan
- [x] uv run pytest tests/unit/test_examples_catalog.py -v
- [x] npx --no markdownlint-cli on the 5 new/changed README/prompt files
- [x] harness validate
EOF
)"
```

- [ ] **Step 4:** Run: `harness validate`

## Success Criteria

- All 6 tasks complete; `harness validate` passes after each.
- `uv run pytest tests/unit/test_examples_catalog.py -v` green.
- `npx --no markdownlint-cli` green on all 5 new/changed `.md` files.
- Both catalog READMEs list all three new examples.
- Catalog framework mix is 7 pytest / 10 vitest (17 total).
- PR opened against `main` from `feat/realworld-functions-batch8`.
