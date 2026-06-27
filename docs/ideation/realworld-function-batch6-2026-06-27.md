---
topic: >-
  realworld-functions batch 6 — candidate pure-function domain-logic examples
  for the examples/realworld-functions/ catalog (Pytest + Vitest parity),
  distinct from existing examples
generated_at: 2026-06-27T19:01:16Z
strategy_grounded: false
strategy_path: null
count_requested: 10
count_generated: 10
ranking_formula: >-
  (impact × confidence) ÷ effort; L/M/H mapped to 1/2/3. No STRATEGY.md —
  strategy-alignment tiebreaker unavailable; ties broken by hand on teaching
  novelty (noted inline).
---

# Ideation — Real-World Function Example Categories (Batch 6)

- **Date:** 2026-06-27
- **Focus:** Candidate domain functions for `examples/realworld-functions/`
  (batch 6)
- **Grounding:** No `STRATEGY.md` at repo root — strategy-alignment tiebreaker
  **unavailable**; ties broken by hand (noted inline).
- **Method:** Score = `(impact × confidence) ÷ effort`, with L/M/H mapped to 1/2/3.
- **Consumed by:** `harness-brainstorming` (this file is ranked ideation, not
  a spec).

## Context

Catalog after batch 5 (**11 committed**): `lego-tracker-reconcile-collection`,
`subscription-expiry-checker`, `access-policy-evaluator`,
`tax-bracket-calculator`, `order-state-machine` (pytest); `price-normalizer`,
`interval-merger`, `semver-compare`, `money-allocator`, `retry-backoff-schedule`,
`discount-stacking` (vitest) — **5 pytest / 6 vitest**, near parity, so framework
rebalancing is a *weak* driver this round.

The category convention is **prompt-only pure-function examples**
(`prompt.txt` + `README.md`, no committed tests). The strongest examples are not
hard *algorithms* — they are **crisp contracts with a counterintuitive
invariant** that teach a testing skill the existing eleven do not. Only `vitest`
and `pytest` are "unit" preferred frameworks in
`agent/frameworks/registry.json`, so realistic candidates live in those two.

Carry-forwards from batch 4's "below the cut" (`pagination-cursor-codec`,
`fifo-lot-consumer`, `luhn-card-validator`) are re-scored here.
`duration-parser` and `csv-line-parser` are **dropped** this round — the former
overlaps `price-normalizer`'s parse-or-reject lesson, the latter's quoted-field
surface breaks the "one line" framing (scope creep).

**Novelty map** — testing skills the existing 11 already cover: reconciliation,
date/time boundaries, stateless RBAC matrix, marginal bands, parse-or-reject,
interval merging, ordering, sum-invariant, **rng** injection, order-dependence,
discrete state machine. Batch 6 candidates are scored on whether they teach
something *outside* that set.

## Ranked candidates

| Rank | Candidate | Framework | Impact | Conf | Effort | Score |
| ---- | --------- | --------- | :----: | :--: | :----: | :---: |
| 1 | feature-flag-bucketing | vitest | H | M | L | **6.0** |
| 2 | dense-rank-leaderboard | pytest | M | H | L | **6.0** |
| 3 | bytes-humanizer | vitest | M | H | L | **6.0** |
| 4 | pagination-cursor-codec | vitest | M | M | L | **4.0** |
| 5 | business-hours-deadline | pytest | H | M | M | **3.0** |
| 6 | token-bucket-rate-limiter | vitest | H | M | M | **3.0** |
| 7 | fifo-lot-consumer | pytest | M | H | M | **3.0** |
| 8 | luhn-card-validator | pytest | L | H | L | **3.0** |
| 9 | truncate-grapheme | vitest | M | M | M | **2.0** |
| 10 | cron-next-fire | pytest | M | M | H | **1.33** |

**Tie at rank 1** (feature-flag-bucketing, dense-rank-leaderboard,
bytes-humanizer, all 6.0; no `STRATEGY.md` tiebreaker): ordered by teaching
novelty. `feature-flag-bucketing` teaches **deterministic hashing + a
monotonic-rollout property** — a skill *no* existing example covers → #1.
`dense-rank-leaderboard` teaches **tie semantics** (standard vs dense vs
ordinal), a crisp contract that diverges only at ties → #2. `bytes-humanizer`'s
unit-crossing edge is novel but its rounding-at-boundary surface partially
echoes `tax-bracket-calculator` / `price-normalizer` numeric work → #3.

**Tie at rank 5** (business-hours-deadline, token-bucket-rate-limiter,
fifo-lot-consumer, luhn-card-validator, all 3.0): ordered by novelty.
`business-hours-deadline` teaches **injected calendar + clock** — distinct from
`retry-backoff`'s injected *rng* → #5. `token-bucket-rate-limiter` teaches
**continuous state over injected time** → #6. `fifo-lot-consumer` teaches
**partial consumption across ordered lots** → #7. `luhn-card-validator` is a
single code path with thin edge surface → #8.

---

## Selected batch (recommended cut: Top 3)

### 1. feature-flag-bucketing — score 6.0

- **Premise:** `bucket(userId: string, flagKey: string, percentage: number):
  boolean` deterministically assigns a user to a rollout cohort by hashing
  `userId + flagKey` (pinned algorithm, e.g. FNV-1a → `mod 100`) and comparing
  against `percentage`.
- **Persona:** Platform / release engineer running a gradual feature rollout.
- **Framework:** vitest.
- **Complexity:** Low–Medium.
- **Key risk:** If the hash algorithm isn't pinned exactly, the pytest and vitest
  ports produce *different* buckets and cross-framework parity breaks.
- **Strongest objection — ANSWERED:** *"The hash is an implementation detail;
  what's the contract?"* The contract is **not** the hash — it is the
  **monotonic-rollout property**: for a fixed `(userId, flagKey)`, raising
  `percentage` never un-enrolls an already-enrolled user, and assignment is
  **stable** across repeated calls. That property is exactly the kind of
  invariant the catalog rewards, and it is testable without asserting raw hash
  values: enrol-at-50% ⊆ enrol-at-75%, idempotence, `0% → all false`,
  `100% → all true`, and uniform-ish distribution across many ids. Pinning the
  algorithm in the prompt (so both ports agree) turns the parity risk into a
  feature — it teaches that **deterministic hashing is the foundation of stable
  bucketing**, a skill absent from all eleven existing examples.
- Impact **H**, Confidence **M** (algorithm must be pinned precisely), Effort
  **L**.

### 2. dense-rank-leaderboard — score 6.0

- **Premise:** `rank(scores: list[int]) -> list[int]` assigns a competition rank
  to each score under a **pinned tie scheme** (standard `1,2,2,4` *or* dense
  `1,2,2,3` *or* ordinal `1,2,3,4`), descending.
- **Persona:** Backend engineer building a leaderboard / tournament standings.
- **Framework:** pytest.
- **Complexity:** Low.
- **Key risk:** "Ranking" sounds trivial (just sort) — the value evaporates if
  the prompt doesn't make the tie scheme the explicit, load-bearing decision.
- **Strongest objection — ANSWERED:** *"Isn't ranking trivial — just sort?"* The
  sort is incidental; the **lesson is tie handling**. Standard, dense, and
  ordinal ranking are identical until two scores tie, and then they diverge in
  three different directions — a robust suite must prove the implementation
  honors the *declared* scheme rather than silently picking another. This is the
  same move `tax-bracket-calculator` makes: an apparently simple function whose
  whole difficulty lives in one pinned semantic choice. Edge cases write
  themselves: all-equal scores, strictly descending (no ties), a single element,
  empty input, and the "gap after a tie" assertion that *defines* standard vs
  dense.
- Impact **M**, Confidence **H**, Effort **L**.

### 3. bytes-humanizer — score 6.0

- **Premise:** `humanize(bytes: number, opts: { binary: boolean }): string`
  formats a byte count as a human string (`"1.5 KiB"` / `"1.5 kB"`), selecting
  the unit and rounding to one decimal.
- **Persona:** Tooling / CLI engineer formatting file sizes or transfer rates.
- **Framework:** vitest.
- **Complexity:** Low.
- **Key risk:** Boundary rounding overlaps the numeric-edge work in
  `tax-bracket-calculator` / `price-normalizer`; the example dilutes into generic
  rounding if its distinctive edges aren't pinned.
- **Strongest objection — ANSWERED:** *"Boundary rounding overlaps existing
  numeric examples."* The novel surface is two edges those examples never touch:
  (1) **unit-crossing on round** — `1023.95 KiB` must render `1 MiB`, not
  `1024 KiB`, because rounding pushes the value across a unit threshold; and
  (2) **binary vs decimal** — `KiB = 1024` vs `kB = 1000`, selected by `opts`.
  Pinning both in the prompt makes the contract crisp and counterintuitive:
  `humanize(1023)` and `humanize(1024)` straddle the first threshold, and the
  round-up case is the assertion most naive implementations get wrong. Edge
  cases: `0 → "0 B"`, exact powers, negative input → error, the largest unit
  (no overflow past `PiB`/`PB`).
- Impact **M**, Confidence **H**, Effort **L**.

After this batch the catalog is **6 pytest / 8 vitest**. If parity matters more
than novelty to you, swap `bytes-humanizer` (#3, vitest) for the pre-vetted
pytest `fifo-lot-consumer` (#7) — but novelty favors the Top 3 as ranked.

---

## Just below the cut

### 4. pagination-cursor-codec — score 4.0

- **Premise:** `encodeCursor(state) -> string` / `decodeCursor(string) -> state`
  round-trip an opaque pagination cursor (base64url of a small record), rejecting
  tampered or malformed input.
- **Persona:** API engineer implementing keyset/cursor pagination.
- **Framework:** vitest. **Complexity:** Low.
- **Key risk (logged):** Trivial without signing; thin edge surface.
- **Strongest objection (accepted as downside):** The teaching value is
  **encoder/decoder symmetry** — `decode(encode(x)) === x` for all valid `x`,
  plus rejection of garbage — a property-test shape none of the eleven teach. The
  thin edge surface keeps it just below the cut; *first candidate up if the cut
  moves to Top 4.*

## Below the cut (recorded for future batches)

- **business-hours-deadline** (3.0, pytest) —
  `add_business_hours(start, hours, holidays, clock)` skipping weekends +
  holidays. Teaches **injected calendar + clock** (distinct from `retry-backoff`'s
  injected rng). *Risk:* calendar math is a rabbit hole (DST, timezones,
  half-days); bound it to UTC + whole-hour business days + explicit holiday set.
- **token-bucket-rate-limiter** (3.0, vitest) —
  `allow(state, now, capacity, refillRate) -> { allowed, newState }`. Teaches
  **continuous state evolution over injected time** (returns new state). *Risk:*
  refill-rounding semantics must be pinned; framing overlaps `order-state-machine`
  superficially.
- **fifo-lot-consumer** (3.0, pytest) — `consume(lots, qty) ->
  { consumed, remaining }` FIFO depletion, insufficient → error. Teaches
  **partial consumption across ordered lots**. *Risk:* structured return inflates
  effort relative to payoff. Promote if a stateful-inventory shape is wanted.
- **luhn-card-validator** (3.0, pytest) — Luhn checksum. *Risk:* single code
  path, thin coverage; doesn't showcase edge-case *design*.
- **truncate-grapheme** (2.0, vitest) — `truncate(str, max)` honoring grapheme
  clusters / emoji + ellipsis, never splitting a surrogate pair. *Risk:*
  JS-specific; awkward to mirror cleanly in pytest, unicode surface balloons.
- **cron-next-fire** (1.33, pytest) — `next_fire(expr, after)` → next matching
  datetime. *Risk:* highest-novelty but parsing surface balloons (ranges, steps,
  day-of-week); effort H drags the score down.

## Next step

Feed the **Top 3** (`feature-flag-bucketing`, `dense-rank-leaderboard`,
`bytes-humanizer`) into `harness-brainstorming` to design each `prompt.txt` +
`README.md` pair (≈8 cases apiece, matching the established example shape). If
you want a 4-example batch, `pagination-cursor-codec` is the pre-vetted #4. If
parity outranks novelty, substitute `fifo-lot-consumer` (pytest) for
`bytes-humanizer`.
