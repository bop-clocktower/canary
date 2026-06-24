# Ideation — Next Batch of Real-World Function Example Categories

- **Date:** 2026-06-22
- **Focus:** Candidate domain functions for `examples/realworld-functions/`
  (batch 3)
- **Grounding:** No `STRATEGY.md` at repo root — strategy-alignment tiebreaker
  **unavailable**; ties broken by hand (noted inline).
- **Method:** Score = `(impact × confidence) ÷ effort`, with L/M/H mapped to 1/2/3.
- **Consumed by:** `harness-brainstorming` (this file is ranked ideation, not
  a spec).

## Context

Existing batch (committed): `lego-tracker-reconcile-collection` (pytest),
`price-normalizer` (vitest), `subscription-expiry-checker` (pytest),
`access-policy-evaluator` (pytest) — **3 pytest / 1 vitest**.

The category convention is **prompt-only pure-function examples**
(`prompt.txt` + `README.md`, no committed tests). The strongest examples are
not hard
*algorithms* — they are **crisp contracts with a counterintuitive invariant**.
Only `vitest` and `pytest` are "unit" preferred frameworks in
`agent/frameworks/registry.json`, so realistic candidates live in those two.
Candidates were therefore also weighed on framework rebalancing (favor vitest)
and on teaching something the existing four do not.

## Ranked candidates

| Rank | Candidate | Framework | Impact | Conf | Effort | Score |
| ---- | --------- | --------- | :----: | :--: | :----: | :---: |
| 1 | money-allocator | vitest | H | H | L | **9.0** |
| 2 | retry-backoff-schedule | vitest | H | M | L | **6.0** |
| 2 | semver-compare | vitest | M | H | L | **6.0** |
| 4 | tax-bracket-calculator | pytest | H | H | M | **4.5** |
| 5 | pagination-cursor-codec | vitest | M | M | L | **4.0** |
| 6 | luhn-card-validator | pytest | L | H | L | **3.0** |
| 7 | csv-line-parser | pytest | H | M | H | **2.0** |
| 7 | flag-rollout-bucketing | vitest | M | M | M | **2.0** |
| 9 | next-business-time | pytest | M | L | H | **1.3** |

**Tie at rank 2** (no `STRATEGY.md` tiebreaker available): broken in favor of
`retry-backoff-schedule` over `semver-compare` because it teaches a testing
skill none of the existing examples cover (injecting nondeterminism), whereas
`semver-compare`'s "solved problem" objection is its weakness.

---

## Selected batch (cut line: Top 3)

### 1. money-allocator — score 9.0

- **Premise:** `allocate(totalCents: number, ratios: number[]): number[]` splits
  an integer cent amount across ratios so the parts **sum exactly to the total**
  (largest-remainder method — no penny created or lost).
- **Persona:** Billing / fintech engineer splitting an invoice, refund, or payout.
- **Framework:** vitest (rebalances the pytest-heavy catalog).
- **Complexity:** Medium.
- **Key risk:** Distribution rule is a *design choice* (largest-remainder vs.
  round-half-up) — left implicit, generated tests can't be deterministic.
- **Strongest objection — ANSWERED:** "Which rounding rule?" is not a flaw, it
  is the lesson. The prompt pins largest-remainder explicitly, and the headline
  invariant — `sum(allocate(t, r)) === t` for every input — is exactly the kind
  of property the existing examples reward. This mirrors how `price-normalizer`
  pins EU-vs-US decimal semantics. Edge cases write themselves: indivisible
  remainders (`100 / [1,1,1]`), zero ratios, single ratio, empty ratios → error.
- Impact **H**, Confidence **H**, Effort **L**.

### 2. retry-backoff-schedule — score 6.0

- **Premise:** `backoffDelays(attempts, baseMs, capMs, rng): number[]` returns the
  delay sequence for exponential backoff with a ceiling and **full jitter**,
  where `rng` is an **injected** `() => number`.
- **Persona:** Backend / SRE engineer hardening a retry loop.
- **Framework:** vitest.
- **Complexity:** Medium.
- **Key risk:** Jitter is randomness — a naive version produces flaky tests.
- **Strongest objection — ANSWERED:** "Tests will be flaky" is precisely what the
  example exists to refute. By making `rng` a parameter, the function becomes
  deterministic under test: pass `() => 0` and `() => 1` to assert the jitter
  bounds, pass a fixed sequence to assert exact delays. This teaches
  **dependency-injection of nondeterminism** — a real testing skill absent from
  all four existing examples. Edge cases: `attempts = 0` → `[]`, cap clamps the
  exponential, `baseMs = 0`.
- Impact **H**, Confidence **M** (design ambiguity in *how* jitter is injected),
  Effort **L**.

### 3. semver-compare — score 6.0

- **Premise:** `compareVersions(a: string, b: string): -1 | 0 | 1` implements
  SemVer 2.0 precedence: numeric core, prerelease tags rank **below** release,
  identifier-by-identifier prerelease comparison (numeric < alphanumeric), build
  metadata ignored.
- **Persona:** Package-tooling / release-automation engineer.
- **Framework:** vitest.
- **Complexity:** Medium.
- **Key risk:** SemVer is a solved problem with battle-tested libraries.
- **Strongest objection — ANSWERED:** "Why hand-roll it?" The example is not
  advocating you ship a comparator — it demonstrates that Canary can derive a
  **dense, spec-driven decision matrix** from a written contract. SemVer's
  precedence rules are unusually counterintuitive (`1.0.0-alpha < 1.0.0`,
  `1.0.0-alpha.1 < 1.0.0-alpha.beta`, build metadata is *non-comparing*), which
  is exactly the surface that catches under-tested implementations. The value is
  the coverage-design demonstration, not the algorithm.
- Impact **M**, Confidence **H**, Effort **L**.

After this batch the catalog is **3 pytest / 4 vitest** — a healthy rebalance
from the current 3/1.

---

## Below the cut (recorded for future batches)

- **tax-bracket-calculator** (4.5, pytest) — progressive marginal tax, boundary-
  exact. *Risk (logged):* tax rules are locale-specific; readers may anchor on
  their country's quirks. Mitigation if promoted: use abstract generic brackets.
- **pagination-cursor-codec** (4.0, vitest) — opaque cursor round-trip + tamper
  rejection. *Risk:* trivial without signing; little edge surface.
- **luhn-card-validator** (3.0, pytest) — Luhn checksum. *Risk:* single code
  path, thin coverage; doesn't showcase edge-case design.
- **csv-line-parser** (2.0, pytest) — RFC-4180 quoted fields. *Risk:* parsing
  surface balloons; embedded newlines break the "one line" framing (scope creep).
- **flag-rollout-bucketing** (2.0, vitest) — consistent-hash bucketing. *Risk:*
  distribution correctness is statistical, hard to assert deterministically.
- **next-business-time** (1.3, pytest) — skip weekends/holidays/DST. *Risk:*
  timezone/DST makes it date-library-dependent and brittle; fights the
  pure-function theme.

## Next step

Feed the Top 3 into `harness-brainstorming` to design each `prompt.txt` +
`README.md` pair (8 cases apiece, matching the established example shape).
