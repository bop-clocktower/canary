# Real-World Function Examples

Scenarios based on functions you might actually write — a collection
reconciler, a price normaliser, an access-control checker. No synthetic
"login form" or "checkout endpoint": real domain logic, real edge cases.

Each example is **prompt-only**: the directory contains the prompt to
give Canary plus a README describing the expected shape. No generated
test files are committed — run `/canary-write-test` in Claude Code to
produce fresh output.

## Catalog

| Example | Type | Framework | What it demonstrates |
| ------- | ---- | --------- | -------------------- |
| [lego-tracker-reconcile-collection](lego-tracker-reconcile-collection/) | Unit | Pytest | Reconcile two LEGO set lists into matched / local-only / api-only |
| [price-normalizer](price-normalizer/) | Unit | Vitest | Parse mixed-format price strings (US, EU, bare) into a canonical struct |
| [subscription-expiry-checker](subscription-expiry-checker/) | Unit | Pytest | Bucket subscriptions into expired / expiring-soon / active by date |
| [access-policy-evaluator](access-policy-evaluator/) | Unit | Pytest | RBAC check — roles × actions with wildcard grants and role ordering |
| [interval-merger](interval-merger/) | Unit | Vitest | Merge overlapping / adjacent ranges into a sorted non-overlapping set |
| [semver-compare](semver-compare/) | Unit | Vitest | Order semver strings — prerelease, identifier, and build-metadata rules |
| [tax-bracket-calculator](tax-bracket-calculator/) | Unit | Pytest | Marginal tax across progressive brackets with boundary and reject cases |
| [money-allocator](money-allocator/) | Unit | Vitest | Split cents by ratio so parts sum exactly to total (largest-remainder) |
| [order-state-machine](order-state-machine/) | Unit | Pytest | Advance a state machine — terminal absorption, illegal-transition rejection |
| [retry-backoff-schedule](retry-backoff-schedule/) | Unit | Vitest | Exponential backoff with full jitter via an injected rng (deterministic) |
| [discount-stacking](discount-stacking/) | Unit | Vitest | Stack ordered % and fixed discounts — order-dependence, clamp, total cap |
| [feature-flag-bucketing](feature-flag-bucketing/) | Unit | Vitest | Deterministic % rollout via FNV-1a hash — monotonic enrollment, `<` boundary |
| [dense-rank-leaderboard](dense-rank-leaderboard/) | Unit | Pytest | Competition ranking — tied scores share a rank, next score skips the gap |
| [bytes-humanizer](bytes-humanizer/) | Unit | Vitest | Format bytes (1.5 KiB) — unit-crossing round, binary vs decimal base |
| [pagination-cursor-codec](pagination-cursor-codec/) | Unit | Vitest | Tamper-evident pagination cursor — checksum round-trip, integer-only state |
| [business-hours-deadline](business-hours-deadline/) | Unit | Pytest | Add business hours across nights/weekends/holidays, round-up-first rounding |
| [token-bucket-rate-limiter](token-bucket-rate-limiter/) | Unit | Vitest | Continuous token-bucket refill — injected clock, capacity cap, clock-skew reject |
| [fifo-lot-consumer](fifo-lot-consumer/) | Unit | Pytest | FIFO inventory consumption — partial/exact draining, order-preserving remainder, conservation invariant |
| [luhn-card-validator](luhn-card-validator/) | Unit | Pytest | Luhn checksum validation — doubling-reduction, malformed-input reject, minimal 2-digit edge case |

## How these differ from the top-level examples

The top-level [`examples/`](../) directory shows framework mechanics
(Playwright page-object model, k6 load profiles). These examples start
from **domain logic** — a function signature and its invariants — and let
Canary pick the test approach.

Good for:

- Teams who already know their stack and want to test a specific helper
- Prompts where "just write pytest" is obvious but coverage design is hard
- Demonstrating that Canary understands pure-function contracts, not just
  HTTP interactions

## Adding an example

Copy any existing directory, update `prompt.txt` and `README.md`, and
add a row to this table and to [`examples/README.md`](../README.md).
