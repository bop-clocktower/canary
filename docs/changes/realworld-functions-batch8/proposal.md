# Real-World Function Examples — Batch 8

**Status:** approved (design sign-off pending)
**Type:** docs/examples (prompt-only) — small change, no production code
**Keywords:** realworld-functions, examples, prompt-only, vitest, pytest,
pagination, checksum, business-hours, calendar, token-bucket, rate-limiter,
catalog

## Overview and goals

Add three pure-function examples to `examples/realworld-functions/`,
continuing the prompt-only catalog (`prompt.txt` + `README.md`, no committed
tests). Selected from the leftover ranked pool in
`docs/ideation/realworld-function-batch6-2026-06-27.md` ("Just below the cut"
/ "Below the cut" sections) — that batch's own Top 3 already shipped. Goal:
each example teaches a testing skill the existing fourteen do not.

Out of scope: implementing the functions (examples are prompt-only), changing
the example template, adding frameworks or property-test libraries (not in
the registry), the remaining ideation candidates not selected for this batch
(fifo-lot-consumer, luhn-card-validator, truncate-grapheme, cron-next-fire —
left for a future batch).

## Decisions made

| Decision | Choice | Rationale |
| --- | --- | --- |
| Batch size | 3 (pagination-cursor-codec, business-hours-deadline, token-bucket-rate-limiter) | Matches batch4/batch6 cadence; balances pytest/vitest |
| pagination-cursor-codec: tamper detection | Include a checksum, reject tampered input | Directly addresses the ideation doc's own flagged risk ("trivial without signing") |
| pagination-cursor-codec: state shape | Pinned `{ id: number; createdAt: number }`, both must be integers | Avoids an untestable generic `Record<string, unknown>`; integers pinned per this repo's numeric-example soundness convention |
| business-hours-deadline: business window | Fixed 9:00–17:00 UTC, Mon–Fri | Bounds the doc's own "rabbit hole" risk (DST/timezone/half-day complexity) tightly |
| business-hours-deadline: `hours` type | Non-negative `int` only | Pinned per this repo's numeric-example soundness convention; float/negative rejected |
| token-bucket-rate-limiter: refill model | Continuous (float tokens), no rounding | Sidesteps a second nested decision (leftover-time banking) discrete would force |
| token-bucket-rate-limiter: numeric contract | All four params (`tokens`, `lastRefill`, `now`, `capacity`, `refillRate`) are floats, explicitly stated in `prompt.txt` | Pinned per this repo's numeric-example soundness convention (continuous domain, not integer, but still explicit) |

## Technical design

Each example is a directory under `examples/realworld-functions/` containing
`prompt.txt` (signature + rules + 8 numbered cases) and `README.md` (locked
structure: summary → "X unit example" → Prompt → Run it → What Canary should
produce → Running the generated test → Variations to try → See also).

### pagination-cursor-codec (vitest)

`encodeCursor(state: { id: number; createdAt: number }): string` /
`decodeCursor(cursor: string): { id: number; createdAt: number }` —
JSON-serializes `state`, appends a checksum, base64url-encodes the result.
`decodeCursor` reverses this and verifies the checksum, rejecting tampered
input. `id`/`createdAt` must be integers (`Number.isInteger`) — `encodeCursor`
throws `RangeError` on non-integer input.

Cases: (1) round-trip preserves exact state; (2) round-trip with `id: 0`;
(3) tampered payload (flipped byte) → decode throws; (4) malformed base64 →
throws; (5) empty string → throws; (6) truncated cursor (valid base64, too
short for payload+checksum) → throws; (7) non-integer `id`/`createdAt` at
encode time → throws; (8) `Number.MAX_SAFE_INTEGER` values round-trip
correctly.

Headline invariant: `decodeCursor(encodeCursor(s)) === s` for all valid
integer-keyed `s`, and any single-byte tamper is rejected.

### business-hours-deadline (pytest)

`add_business_hours(start: datetime, hours: int, holidays: set[date]) ->
datetime` — fixed window 9:00–17:00 UTC, Mon–Fri, minus `holidays`. `hours`
must be a non-negative `int` (float/negative → `ValueError`). If `start`
falls outside the business window, first rounds up to the next valid
window-start before consuming any of the `hours` budget.

Cases: (1) same-day addition, no skip; (2) crosses end-of-day → rolls to next
business day; (3) crosses a weekend; (4) crosses an explicit holiday;
(5) `start` outside business hours (e.g. 20:00) → rounds up first;
(6) `hours=0` returns `start` unchanged if already in-window, else the
rounded-up window-start; (7) multi-day span (`hours=20`) walks multiple full
8-hour days; (8) negative `hours` → `ValueError`.

Headline invariant: every business day contributes exactly 8 business-hours;
weekends/holidays contribute zero.

### token-bucket-rate-limiter (vitest)

`allow(state: { tokens: number; lastRefill: number }, now: number, capacity:
number, refillRate: number): { allowed: boolean; newState: { tokens: number;
lastRefill: number } }` — continuous/float tokens. Refill = `(now -
lastRefill) * refillRate`, capped at `capacity`. Consuming costs exactly `1`
token if `tokens >= 1` after refill. `capacity` must be `> 0`, `refillRate >=
0`, elapsed time (`now - lastRefill`) must be `>= 0` — all violations throw
`RangeError`.

Cases: (1) fresh full bucket, one request allowed; (2) repeated draining
until `allowed=false`; (3) refill after elapsed time restores tokens;
(4) refill caps at `capacity`; (5) zero elapsed time, pure consume-check;
(6) tokens exactly `1.0` → allowed, becomes `0.0`; (7) `capacity <= 0` →
`RangeError`; (8) negative elapsed (`now < lastRefill`, clock skew) →
`RangeError`.

Headline invariant: `tokens` never exceeds `capacity`, never goes negative.

## Integration Points

- **Entry Points:** three new example directories under
  `examples/realworld-functions/` (`pagination-cursor-codec/`,
  `business-hours-deadline/`, `token-bucket-rate-limiter/`), each with
  `prompt.txt` + `README.md`.
- **Registrations Required:** add one catalog row per example to BOTH
  `examples/realworld-functions/README.md` and `examples/README.md` (the
  structural test `tests/unit/test_examples_catalog.py` enforces the
  realworld-functions-level link).
- **Documentation Updates:** the two catalog READMEs above. No AGENTS.md
  change.
- **Architectural Decisions:** None (no ADR — small docs change).
- **Knowledge Impact:** None.

## Success criteria

- Three new directories exist, each with `prompt.txt` + `README.md` matching
  the locked template shape (8 numbered cases in the prompt).
- Both catalog READMEs list all three; `tests/unit/test_examples_catalog.py`
  passes.
- markdownlint passes on the new READMEs.
- Catalog framework mix after this batch: 7 pytest / 10 vitest (17 total).

## Implementation order

1. Create the three directories with `prompt.txt` + `README.md`
   (template-faithful).
2. Add catalog rows to both READMEs.
3. Run `test_examples_catalog.py` + markdownlint; verify green.
4. Commit on a feature branch; open PR.
