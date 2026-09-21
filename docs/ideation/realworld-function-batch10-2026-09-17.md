---
topic: >-
  realworld-functions batch 10 — fresh candidate pure-function domain-logic
  examples for the examples/realworld-functions/ catalog (Pytest + Vitest
  parity), distinct from the 19 shipped examples; the batch-6 below-the-cut pool
  is exhausted
generated_at: 2026-09-17T18:30:00Z
strategy_grounded: true
strategy_path: STRATEGY.md
count_requested: 10
count_generated: 10
ranking_formula: >-
  (impact × confidence) ÷ effort; L/M/H mapped to 1/2/3; strategy-alignment
  tiebreaker (max +0.75) applied only when |Δbase_score| ≤ 0.05
---

# Ideation — Real-World Function Example Categories (Batch 10)

## Inputs

- **Topic:** fresh candidate domain functions for
  `examples/realworld-functions/` (batch 10)
- **Generated:** 2026-09-17T18:30:00Z
- **Strategy grounding:** **enabled** — `STRATEGY.md` v2 present and valid.
  Relevant tracks: _Adoption and onboarding_ ("shorten the distance from install
  to a first trustworthy gate") and _Test intelligence depth_ (edge-case
  discovery, generated-test soundness). Target problem: "teams ship test suites
  that pass without proving anything" — an example whose whole lesson is
  **edge-case design** speaks to it directly.
- **Method:** Score = `(impact × confidence) ÷ effort`, L/M/H → 1/2/3.
- **Consumed by:** `harness-brainstorming` (this file is ranked ideation, not a
  spec).

## Context

Catalog after batch 9 (**19 committed**, 9 pytest / 10 vitest):
`lego-tracker-reconcile-collection`, `subscription-expiry-checker`,
`access-policy-evaluator`, `tax-bracket-calculator`, `order-state-machine`,
`dense-rank-leaderboard`, `business-hours-deadline`, `fifo-lot-consumer`,
`luhn-card-validator` (pytest); `price-normalizer`, `interval-merger`,
`semver-compare`, `money-allocator`, `retry-backoff-schedule`,
`discount-stacking`, `feature-flag-bucketing`, `bytes-humanizer`,
`pagination-cursor-codec`, `token-bucket-rate-limiter` (vitest).

**This round is fresh ideation, not a pool draw.** Batch 6's ranked pool is
exhausted: its two survivors were rejected on named risks that have not changed
— `truncate-grapheme` (JS-specific grapheme/surrogate handling is awkward to
mirror in pytest, breaking the catalog's framework-parity convention) and
`cron-next-fire` (ranges/steps/day-of-week make the parsing surface unbounded).
Both stay rejected here and are **not** re-scored.

Only `vitest` and `pytest` are "unit" preferred frameworks in the framework
registry, so realistic candidates live in those two.

**Novelty map** — testing skills the existing 19 already cover: reconciliation;
date/time bucketing; stateless RBAC matrix; marginal bands; parse-or-reject;
interval merging; total ordering; sum-invariant / largest-remainder; injected
rng; order-dependence and clamping; discrete state machine; deterministic
hashing with a monotonic-rollout property; tie semantics; unit-crossing
rounding; codec round-trip with tamper rejection; injected calendar + clock;
continuous state over injected time; FIFO partial consumption with a
conservation invariant; checksum digit reduction. Batch 10 candidates are scored
on whether they teach something **outside** that set.

**Standing hard filters this round** (from the issue and the project's soundness
rules):

- Any numeric example must **pin its integer/fractional input contract
  explicitly**, or soundness check S4 fails.
- Reject **framework-parity risk** — anything whose semantics differ between
  Python and JS/TS.
- Reject an **unbounded parsing surface** — anything whose rule list grows
  without a natural stopping point.

## Ranked candidates

| Rank | Candidate                 | Framework | Impact | Conf | Effort | Base |    Align     |  Final   |
| ---- | ------------------------- | --------- | :----: | :--: | :----: | :--: | :----------: | :------: |
| 1    | topological-task-order    | pytest    |   H    |  H   |   L    | 9.00 | +0.75 (rec.) | **9.00** |
| 2    | percentile-nearest-rank   | vitest    |   M    |  H   |   L    | 6.00 | +0.75 (rec.) | **6.00** |
| 3    | path-normalizer-posix     | vitest    |   M    |  M   |   L    | 4.00 | +0.75 (rec.) | **4.00** |
| 4    | bankers-rounding-splitter | vitest    |   L    |  H   |   L    | 3.00 |    +0.50     | **3.00** |
| 5    | run-length-codec          | vitest    |   L    |  H   |   L    | 3.00 |    +0.50     | **3.00** |
| 6    | bin-packing-first-fit     | pytest    |   M    |  M   |   M    | 2.00 |    +0.75     | **2.75** |
| 7    | weighted-round-robin      | vitest    |   M    |  M   |   M    | 2.00 |    +0.50     | **2.50** |
| 8    | csv-line-parser           | vitest    |   M    |  M   |   H    | 1.33 | +0.50 (rec.) | **1.33** |
| 9    | ranked-choice-irv         | pytest    |   H    |  L   |   H    | 1.00 | +0.75 (rec.) | **1.00** |
| 10   | e164-phone-normalizer     | pytest    |   M    |  L   |   H    | 0.67 | +0.50 (rec.) | **0.67** |

**Tiebreaker applications.** The alignment bonus is bounded and only fires
inside a `|Δbase| ≤ 0.05` window; elsewhere it is _recorded_ (marked "rec.") but
does not reorder. Two windows opened:

- **Ranks 4–5 (both 3.00).** `bankers-rounding-splitter` and `run-length-codec`
  each advance _Adoption and onboarding_ (+0.5) but neither teaches edge-case
  design beyond what the catalog already shows, so neither earns the +0.25
  target-problem bonus. Still tied at 3.00 → **stable order preserved**
  (generation order).
- **Ranks 6–7 (both 2.00).** `bin-packing-first-fit` earns +0.5 (track) and
  +0.25 (its whole lesson is edge-case design around a capacity boundary) =
  **2.75**; `weighted-round-robin` earns +0.5 only = **2.50**. The bonus
  legitimately separates them.

No bonus crosses a non-tied boundary, so the base-score order is intact at every
other rank.

---

## Selected batch (recommended cut: Top 2)

The cut is **2**, matching batch 9's size, and it lands one pytest and one
vitest — taking the catalog to **10 pytest / 11 vitest (21 total)**, closer to
parity than batch 9 left it.

### 1. topological-task-order — score 9.00

- **Premise:** `order(tasks: dict[str, list[str]]) -> list[str]` returns a
  dependency-respecting execution order for a task graph, breaking ties
  lexicographically and rejecting cycles and unknown prerequisites.
- **Persona:** The engineer mid-development (STRATEGY.md's primary) writing a
  build-step, migration, or job-graph sequencer — the single most common "I
  wrote this helper myself" shape not yet in the catalog.
- **Framework:** pytest.
- **Complexity:** Low.
- **Impact H / Confidence H / Effort L** — base **9.00**.
- **Strategy alignment (recorded, not applied):** +0.5 _Adoption and
  onboarding_, +0.25 target problem — the contract is precisely an edge-case
  design exercise.
- **Key risk:** "Topological sort" reads as a solved textbook algorithm, so the
  example could teach library recall rather than contract design.
- **Strongest objection:** _"This is a textbook algorithm — a generated suite
  will just assert the known answer and learn nothing."_ Most likely failure
  mode: the prompt states "topologically sort these tasks", the model emits
  three happy-path chains, and the example becomes an algorithm quiz with no
  edge surface. For this objection **not** to hold, the load-bearing decision
  has to be the part topological sort leaves _undefined_: a valid graph has many
  valid orders, so an untied prompt makes the function untestable by equality.
  Pinning a **deterministic tiebreak** (among all tasks whose prerequisites are
  already emitted, take the lexicographically smallest) collapses the output to
  exactly one list and turns "many valid answers" into a single assertable
  contract — the same move `dense-rank-leaderboard` makes with tie schemes. The
  genuinely novel edges then follow: dependency order must _beat_ lexicographic
  order (`{"b": [], "a": ["b"]}` → `["b", "a"]`, not `["a", "b"]`), two
  independent chains must interleave by the tiebreak rather than run
  one-then-the-other, a self-dependency and a two-node cycle must both raise,
  and a prerequisite naming a task that does not exist must raise rather than be
  silently skipped. No existing example teaches **graph/partial-order
  resolution**, and none teaches **a deterministic tiebreak layered over a
  partial order**.
- **Objection answered:** no — standing (autonomous run; the agent does not
  author rebuttals).
- **Filter check:** no numeric input at all, so S4 does not apply. Input is a
  string→string-list mapping that mirrors exactly between `dict[str, list[str]]`
  and `Record<string, string[]>` — no parity risk. Rule list is closed (order,
  tiebreak, cycle, unknown prerequisite) — no parsing surface.

### 2. percentile-nearest-rank — score 6.00

- **Premise:** `percentile(values: number[], p: number): number` returns the
  p-th percentile of an integer sample under the **nearest-rank** method with an
  explicitly pinned integer rank computation.
- **Persona:** The tooling or platform engineer computing p95 latency from a
  batch of measurements without reaching for a stats dependency.
- **Framework:** vitest.
- **Complexity:** Low.
- **Impact M / Confidence H / Effort L** — base **6.00**.
- **Strategy alignment (recorded, not applied):** +0.5 _Test intelligence
  depth_, +0.25 target problem.
- **Key risk:** Percentile has at least nine published definitions; if the
  method is not pinned to the digit, the pytest and vitest ports disagree and
  every expected value in the prompt becomes arguable.
- **Strongest objection:** _"Rounding boundaries are already covered by
  `tax-bracket-calculator` and `bytes-humanizer` — this is a third rounding
  example."_ Most likely failure mode: the prompt says "compute the p-th
  percentile", a model picks linear interpolation, and the example dissolves
  into generic float-rounding that the catalog has taught twice. For this
  objection **not** to hold, the lesson has to be the thing the existing two
  never touch: **a pinned estimator whose rank arithmetic is exact integer
  arithmetic, not floating-point**. Pinning `rank = ceil((p × N) ÷ 100)`,
  clamped to `[1, N]`, with the multiply performed _before_ the divide, makes
  the result identical in both languages and removes float drift entirely
  (`p=40, N=5` → `200 ÷ 100 = 2` exactly, never `2.0000000000000004`). That pin
  also produces the counterintuitive assertion naive implementations miss: at an
  **exact multiple**, `ceil` does _not_ round up, so `p=40` and `p=30` on a
  five-element sample return the **same** element while `p=50` moves on — a
  discontinuity that only an estimator-aware suite predicts. The remaining edges
  are the clamp at both ends (`p=0` → minimum, `p=100` → maximum), a
  single-element sample where the clamp is the only thing preventing an
  out-of-range index, and an unsorted input that proves the function sorts a
  **copy** rather than mutating its argument.
- **Objection answered:** no — standing (autonomous run).
- **Filter check (S4):** the numeric contract is pinned on both parameters —
  `values` must be a non-empty array of **integers**, `p` must be an **integer**
  in `[0, 100]`; a fractional `p` (`50.5`), a fractional element, an
  out-of-range `p`, or an empty array all raise rather than coerce. No
  fractional input ever enters the function, which is what makes the exact
  integer rank arithmetic sound.

---

## Just below the cut

### 3. path-normalizer-posix — score 4.00 (vitest)

- **Premise:** `normalize(base: string, target: string): string` resolves a
  POSIX-style relative path containing `.` and `..` against a base and
  **rejects** any result that escapes the base.
- **Key risk (logged):** its rejection lesson partially echoes
  `pagination-cursor-codec`'s tamper rejection.
- **Strongest objection (accepted as downside):** the teaching value is real and
  security-flavoured — a traversal-escape check is the rare invariant where the
  _rejection_ path is the whole point, and `a/b/../../..` escaping while
  `a/b/../..` does not is a genuinely off-by-one boundary. But "malformed input
  is rejected, not normalized" is now the catalog's most repeated lesson
  (`price-normalizer`, `pagination-cursor-codec`, `luhn-card-validator`), which
  keeps it just below the cut. _First candidate up if the cut moves to Top 3._
  Bounded surface — no symlinks, no Windows paths, no encoding.

## Below the cut (recorded for future batches)

- **bankers-rounding-splitter** (3.00, vitest) — half-to-even rounding across a
  list of amounts. _Cut for overlap:_ the exact-sum and rounding-boundary
  lessons are `money-allocator` and `bytes-humanizer` respectively; half-even
  alone is too thin a delta to carry an example.
- **run-length-codec** (3.00, vitest) — `encode`/`decode` round-trip. _Cut for
  overlap:_ `decode(encode(x)) === x` plus garbage rejection is
  `pagination-cursor-codec`'s exact lesson, with a smaller edge surface.
- **bin-packing-first-fit** (2.75, pytest) — pack items into fixed-capacity
  bins, first-fit-decreasing. _Cut for overlap:_ the capacity-and-conservation
  invariant is `fifo-lot-consumer`'s; the heuristic-order lesson is
  `discount-stacking`'s. Would need a numeric pin (integer capacities and sizes)
  if promoted.
- **weighted-round-robin** (2.50, vitest) — `next(state)` picks a target by
  weight and returns new state. _Cut for overlap:_ "continuous state evolved
  across calls with an injected input" is `token-bucket-rate-limiter`, and
  smoothing semantics are contested enough to be a second pinning burden.
- **csv-line-parser** (1.33, vitest) — **hard reject, unbounded parsing
  surface.** Quoted fields, escaped quotes, embedded newlines, trailing
  separators and dialect flags have no natural stopping point; dropped for the
  same reason in batch 6 and the reason has not changed.
- **ranked-choice-irv** (1.00, pytest) — instant-runoff elimination rounds.
  **Hard reject, unbounded rule surface:** exhausted ballots, simultaneous
  elimination, tie-break-at-elimination and majority-threshold definitions each
  fork further, and every fork has to be pinned in the prompt or the ports
  diverge. High novelty (iterative elimination is absent from the catalog) but
  confidence L and effort H — revisit only with a drastically narrowed variant.
- **e164-phone-normalizer** (0.67, pytest) — **hard reject, unbounded parsing
  surface plus external data.** Correctness depends on a country-code and
  national-prefix table that is real-world data, not a pinnable contract; an
  example that is wrong for some countries teaches the wrong habit.
- **truncate-grapheme** (carried from batch 6, **not re-scored**) — **hard
  reject, framework-parity risk.** Grapheme-cluster and surrogate-pair semantics
  differ between Python `str` and JS UTF-16 strings, so the two ports cannot
  assert the same expected values.
- **cron-next-fire** (carried from batch 6, **not re-scored**) — **hard reject,
  unbounded parsing surface.** Ranges, steps, day-of-week aliases and the
  day-of-month/day-of-week OR rule keep expanding the expression grammar.

## Next step

Feed the **Top 2** (`topological-task-order`, `percentile-nearest-rank`) into
`harness-brainstorming` to design each `prompt.txt` + `README.md` pair (8 cases
apiece, matching the established example shape). If a 3-example batch is wanted,
`path-normalizer-posix` is the pre-vetted #3.
