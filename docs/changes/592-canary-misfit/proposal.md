# canary-misfit: E2E resilience injection at the Playwright route layer (#592)

**Keywords:** resilience, fault-injection, chaos, playwright-route, degradation
profile, seeded-reproduction, per-flow-verdict, advisory, abstention

> **Status: spec (autonomous lane, 2026-09-17).** The four forks the human
> answered are recorded as D1-D4 below and are **confirmed**, not assumed.
> Everything marked _assumption_ was chosen by the authoring lane with a
> recommended default and no wait. Implementation ships in this same change.

## Overview

`canary-misfit` wraps a Playwright run in adversarial network conditions and
reports, per flow, whether the flow **degraded gracefully**, **degraded**, or
**shattered**. Injection happens at Playwright's `route` layer, so the
application under test needs no change — the same additive-safe property that
makes `canary-instrument` wireable into an existing suite.

It is not a gate. The deliverable is that a human looked at a per-flow verdict
and decided; a flow that shatters under a 5xx burst may be an accepted risk.

### Goals

1. Four fault kinds at the browser boundary: route-level **latency**, **5xx
   bursts**, **aborted responses**, and **slow-network profiles**.
2. A **seeded, reproducible** degradation profile — a reported failure comes
   with the exact command that reproduces it.
3. One **shared degradation-profile vocabulary** that #858's load-scenario
   composer can reuse at the protocol/load layer, so canary does not grow two.
4. A per-flow verdict (`graceful` / `degraded` / `shattered`), advisory.
5. Never report a verdict it did not measure: a flow no fault ever touched is
   **unexercised**, and a run with zero exercised flows **abstains**.

### Out of scope

- Any gate, required check, or exit code that fails CI by default.
- Service-level chaos (pod kills, dependency outages) — that is harness's
  `harness-chaos` territory, at a different layer (see Preconditions).
- Non-Playwright producers for v1 (D1).
- Fixing the resilience gaps it finds.

## Decisions

| #   | Decision                | Choice                                                                                                                                                     | Basis                                                                                                                                        |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Producer scope (open q) | **Playwright-only for v1.** The profile schema and the report artifact are producer-neutral (`producer` field, no Playwright types in the report contract) | Human CONFIRM. A pytest/requests injector can be added later without a schema break.                                                         |
| D2  | `canary-instrument`     | **Standalone.** `canary-misfit` neither requires nor conflicts with `canary-instrument`; composition is documented as **optional**                         | Human CONFIRM. The route fixture and the OTel fixture both extend `test` and compose by chaining; neither reads the other's artifact.        |
| D3  | Profile definition      | **Seeded, reproducible degradation profile** shared with #858: `latency`, `error`, `abort`, `network` fault kinds plus named network envelopes             | Human CONFIRM + issue cross-link. #858 attaches the same `network` envelopes at the protocol layer.                                          |
| D4  | Output                  | **Per-flow verdict, advisory.** Markdown + `--json`; exit 0 always unless `--strict`                                                                       | Human CONFIRM + issue body.                                                                                                                  |
| D5  | Injection decision      | `mulberry32(fnv1a(seed \| faultId \| METHOD url #ordinal))` — a pure function of the seed and the request identity, not of arrival order                   | _Assumption._ Order-independent keying is what makes a parallel run reproducible; a per-fault counter would not be.                          |
| D6  | Surface                 | A **skill only** (`agents/skills/claude-code/canary-misfit/`), no `ts/` CLI subcommand                                                                     | _Assumption._ Peers (`canary-screech`, `canary-fail-fast`, `canary-katana`) are self-contained `.mjs` skills; nothing here needs the engine. |
| D7  | Exit contract           | Advisory exit 0. Under `--strict`: `1` any shattered flow, `3` (`EXIT_ABSTAINED`) zero exercised flows, `0` otherwise                                      | Family-wide #508 D3/D4 contract.                                                                                                             |
| D8  | Degraded threshold      | A passing flow is `degraded` when it retried, or when its duration exceeds `budget_ms` (profile field, default: 2x the sum of injected latency)            | _Assumption._ A flow that survived only by burning the user's patience is not "graceful", and the budget has to be stated to be checked.     |

## Preconditions (adopted from harness-chaos)

Do **not** run `canary-misfit` against a system with no resilience mechanisms
implemented. If nothing retries, times out, or falls back, every flow shatters
and the report says nothing about the system beyond "it has no resilience yet".
Pair with a resilience-implementation pass first; the report is only informative
once there is behaviour to exercise. This precondition is stated in `SKILL.md`,
not only here.

## The degradation profile (shared vocabulary, `schema_version: 1`)

```jsonc
{
  "schema_version": 1,
  "name": "flaky-upstream",
  "seed": 1337,
  "budget_ms": 8000,
  "faults": [
    {
      "id": "api-latency",
      "kind": "latency",
      "match": "**/api/**",
      "rate": 0.5,
      "delay_ms": 800,
    },
    {
      "id": "orders-5xx",
      "kind": "error",
      "match": "**/api/orders*",
      "rate": 0.2,
      "status": 503,
      "burst": 3,
    },
    {
      "id": "flaky-socket",
      "kind": "abort",
      "match": "**/api/**",
      "rate": 0.05,
      "reason": "connectionreset",
    },
    { "id": "edge", "kind": "network", "profile": "slow-3g" },
  ],
}
```

Named network envelopes (`slow-3g`, `fast-3g`, `regional-edge`, `satellite`)
each resolve to `latency_ms` / `jitter_ms` / `loss_rate` / `bandwidth_kbps`.
**That envelope table is the part #858 reuses**: at the route layer the envelope
becomes per-request delay, at the load layer it becomes a k6 network profile —
same names, same four numbers, one definition.

## Verdict rules

| Flow outcome                                     | Verdict       |
| ------------------------------------------------ | ------------- |
| no fault was applied to any of its requests      | `unexercised` |
| passed, no retry, duration within `budget_ms`    | `graceful`    |
| passed but retried, or duration over `budget_ms` | `degraded`    |
| failed / timed out                               | `shattered`   |

`unexercised` flows are reported and **excluded from the denominator**. Zero
exercised flows prints the family's `ABSTAINED` line and, under `--strict`,
exits 3 — a "0 flows shattered" summary over zero flows is the false green this
rule exists to prevent.

## Success criteria

1. A profile file round-trips through validation with named errors for a bad
   `kind`, a `rate` outside 0..1, an unknown network envelope, and a duplicate
   fault `id`.
2. The same `(seed, profile, request sequence)` yields the identical injection
   decisions across runs and processes; a different seed yields different ones.
3. Every report names the seed and prints a copy-pasteable reproduce command.
4. Each of the four fault kinds is representable and classified end to end.
5. Zero exercised flows abstains loudly; `--strict` exits 3.
6. `--strict` exits 1 when any flow shattered, 0 when none did.
7. The skill passes the discovery-driven CLI conformance suite and the skill
   gate-conformance registry unchanged.

## Risks

- **The fixture cannot be executed in this repo.** Playwright is not a
  dependency of canary and no browser is installed, so the shipped route fixture
  is verified by contract tests against its pure decision engine, not by a live
  browser run. Same posture as `canary-instrument`'s OTel bootstrap, which is
  likewise excluded from the coverage gate.
- **Reproduction is per-request-identity, not per-arrival-order** (D5). Two
  requests to the same URL within a flow are distinguished by ordinal, so a
  suite that changes how many times it calls a URL changes the decisions. Stated
  in `SKILL.md`.
