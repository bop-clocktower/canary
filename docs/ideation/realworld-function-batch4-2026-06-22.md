# Ideation — Real-World Function Example Categories (Batch 4)

- **Date:** 2026-06-22
- **Focus:** Candidate domain functions for `examples/realworld-functions/`
  (batch 4)
- **Grounding:** No `STRATEGY.md` at repo root — strategy-alignment tiebreaker
  **unavailable**; ties broken by hand (noted inline).
- **Method:** Score = `(impact × confidence) ÷ effort`, with L/M/H mapped to 1/2/3.
- **Consumed by:** `harness-brainstorming` (this file is ranked ideation, not
  a spec).

## Context

Catalog after v5.4.0 (7 committed): `lego-tracker-reconcile-collection`,
`subscription-expiry-checker`, `access-policy-evaluator`,
`tax-bracket-calculator` (pytest); `price-normalizer`, `interval-merger`,
`semver-compare` (vitest) — **4 pytest / 3 vitest**, well balanced, so framework
rebalancing is a *weak* driver this round.

The category convention is **prompt-only pure-function examples**
(`prompt.txt` + `README.md`, no committed tests). The strongest examples are
not hard
*algorithms* — they are **crisp contracts with a counterintuitive invariant**
that teach a testing skill the existing seven do not. Only `vitest` and `pytest`
are "unit" preferred frameworks in `agent/frameworks/registry.json`, so realistic
candidates live in those two.

`money-allocator` and `retry-backoff-schedule` ranked #1 and #2 in the batch-3
ideation but were **not shipped** (batch 3 took `interval-merger`,
`semver-compare`, `tax-bracket-calculator`). They are carried forward here.

## Ranked candidates

| Rank | Candidate | Framework | Impact | Conf | Effort | Score |
| ---- | --------- | --------- | :----: | :--: | :----: | :---: |
| 1 | money-allocator | vitest | H | H | L | **9.0** |
| 2 | order-state-machine | pytest | H | H | L | **9.0** |
| 3 | retry-backoff-schedule | vitest | H | M | L | **6.0** |
| 4 | discount-stacking | vitest | H | M | L | **6.0** |
| 5 | duration-parser | pytest | M | H | L | **6.0** |
| 6 | pagination-cursor-codec | vitest | M | M | L | **4.0** |
| 7 | fifo-lot-consumer | pytest | M | H | M | **3.0** |
| 7 | luhn-card-validator | pytest | L | H | L | **3.0** |
| 9 | csv-line-parser | pytest | H | M | H | **2.0** |

**Tie at rank 1** (money-allocator vs order-state-machine, both 9.0; no
`STRATEGY.md` tiebreaker): broken in favor of `money-allocator`. Both are H/H/L.
`money-allocator` edges it on three counts — it is the prior #1 still owed a slot,
its `sum === total` invariant is the single cleanest property-test the catalog can
demonstrate, and as a vitest pick it nudges the mix toward parity. `order-state-
machine` is the stronger *novelty* pick (a contract shape absent from all seven)
and sits a hair behind only because its event-driven-vs-target-state framing
carries a sliver more design ambiguity.

**Tie at rank 3** (retry-backoff-schedule, discount-stacking, duration-parser, all
6.0): ordered by teaching novelty. `retry-backoff-schedule` teaches a skill **no**
existing example covers (DI of nondeterminism) → #3. `discount-stacking` teaches
order-dependence + clamping, also novel → #4. `duration-parser` overlaps
`price-normalizer`'s parse-or-reject shape (its own weakness) → #5.

---

## Selected batch (recommended cut: Top 3)

### 1. money-allocator — score 9.0

- **Premise:** `allocate(totalCents: number, ratios: number[]): number[]`
  splits an integer cent amount across ratios so the parts **sum exactly to the
  total**
  (largest-remainder method — no penny created or lost).
- **Persona:** Billing / fintech engineer splitting an invoice, refund, or payout.
- **Framework:** vitest (nudges the 4/3 mix toward parity).
- **Complexity:** Medium.
- **Key risk:** Distribution rule is a *design choice* (largest-remainder vs.
  round-half-up) — left implicit, generated tests can't be deterministic.
- **Strongest objection — ANSWERED:** *"Which rounding rule?"* is not a flaw,
  it is the lesson. The prompt pins largest-remainder explicitly, and the
  headline
  invariant — `sum(allocate(t, r)) === t` for **every** input — is exactly the kind
  of property the existing examples reward. It mirrors how `price-normalizer` pins
  EU-vs-US decimal semantics. Edge cases write themselves: indivisible remainders
  (`100 / [1,1,1]`), zero ratios, a single ratio, empty ratios → error.
- Impact **H**, Confidence **H**, Effort **L**.

### 2. order-state-machine — score 9.0

- **Premise:** `apply(state: str, event: str, machine: dict) -> str` advances a
  finite state machine over a sparse transition map, returning the next state or
  raising on an illegal transition.
- **Persona:** Backend engineer modeling an order / ticket / deployment lifecycle.
- **Framework:** pytest.
- **Complexity:** Low–Medium.
- **Key risk:** Event-driven (`event` keys) vs. target-state (`to` keys)
  framing is a design choice; left implicit the contract is ambiguous.
- **Strongest objection — ANSWERED:** *"Isn't this just `access-policy-evaluator`'s
  matrix again?"* No — `access-policy` is a stateless permission lookup over
  roles × actions; this is a **stateful, temporal** contract. Its counterintuitive
  surface is entirely different: **terminal states absorb all events** (a delivered
  order rejects `cancel`), **unknown events are rejected** rather than ignored,
  and **self-loops** (`paid → paid` on a duplicate webhook) may be legal no-ops.
  Pinning
  the event-driven framing in the prompt removes the ambiguity. It introduces a
  contract *shape* — the transition table — that none of the seven existing examples
  teach.
- Impact **H**, Confidence **H**, Effort **L**.

### 3. retry-backoff-schedule — score 6.0

- **Premise:** `backoffDelays(attempts, baseMs, capMs, rng): number[]` returns the
  delay sequence for exponential backoff with a ceiling and **full jitter**, where
  `rng` is an **injected** `() => number`.
- **Persona:** Backend / SRE engineer hardening a retry loop.
- **Framework:** vitest.
- **Complexity:** Medium.
- **Key risk:** Jitter is randomness — a naive version produces flaky tests.
- **Strongest objection — ANSWERED:** *"Tests will be flaky"* is precisely what
  the example exists to refute. By making `rng` a **parameter**, the function is
  deterministic under test: pass `() => 0` and `() => 1` to assert the jitter
  bounds, pass a fixed sequence to assert exact delays. This teaches
  **dependency-injection of nondeterminism** — a real testing skill absent from
  all seven existing examples. Edge cases: `attempts = 0 → []`, the cap clamps
  the
  exponential, `baseMs = 0`.
- Impact **H**, Confidence **M** (design ambiguity in *how* jitter is injected),
  Effort **L**.

After this batch the catalog is **5 pytest / 5 vitest** — full parity.

---

## Just below the cut

### 4. discount-stacking — score 6.0

- **Premise:** `applyDiscounts(subtotalCents: number, discounts: Discount[]): number`
  applies an ordered list of percentage and fixed-amount discounts, clamped at 0,
  with an optional total cap.
- **Persona:** Commerce / pricing engineer building a promotions engine.
- **Framework:** vitest.
- **Complexity:** Medium.
- **Key risk:** Stacking order and cap semantics are design choices.
- **Strongest objection — ANSWERED:** *"Stacking order is arbitrary."* The
  arbitrariness **is** the contract under test. `10% off` then `$5 off` ≠ `$5 off`
  then `10% off`, and a robust suite must prove the implementation honors the
  *declared* order rather than silently commuting it. Pinning the order in the
  prompt (and the floor-at-zero / cap rules) turns an ambiguous helper into a crisp,
  counterintuitive contract — the same move `tax-bracket-calculator` makes with
  marginal bands. Edge cases: discount exceeding subtotal (clamp to 0, never
  negative), empty list (identity), cap binding before the last discount.
- Impact **H**, Confidence **M**, Effort **L**. *First candidate up if the cut
  moves to Top 4 — all four answered objections hold.*

## Below the cut (recorded for future batches)

- **duration-parser** (6.0, pytest) — `parse_duration("1h30m")` → seconds; compound
  units, invalid → error. *Risk (logged):* overlaps `price-normalizer`'s
  parse-or-reject lesson; thinner edge surface.
- **pagination-cursor-codec** (4.0, vitest) — opaque cursor round-trip + tamper
  rejection. *Risk:* trivial without signing; little edge surface.
- **fifo-lot-consumer** (3.0, pytest) — `consume(lots, qty)` FIFO depletion with
  a structured `{consumed, remaining}` return, insufficient → error. *Risk:* the
  structured return inflates effort relative to payoff. Teaches partial consumption
  across ordered lots — promote if a stateful-inventory shape is wanted.
- **luhn-card-validator** (3.0, pytest) — Luhn checksum. *Risk:* single code path,
  thin coverage; doesn't showcase edge-case design.
- **csv-line-parser** (2.0, pytest) — RFC-4180 quoted fields. *Risk:* parsing surface
  balloons; embedded newlines break the "one line" framing (scope creep).

## Next step

Feed the **Top 3** into `harness-brainstorming` to design each `prompt.txt` +
`README.md` pair (8 cases apiece, matching the established example shape). If you
want a 4-example batch, `discount-stacking` is the pre-vetted #4 — its objection
is already answered above.
