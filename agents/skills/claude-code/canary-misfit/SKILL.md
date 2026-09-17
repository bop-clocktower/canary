---
name: canary-misfit
description:
  E2E resilience injection — wrap a Playwright run in seeded adversarial
  network conditions (route-level latency, 5xx bursts, aborted responses,
  slow-network profiles) and report a per-flow verdict of graceful, degraded, or
  shattered. Advisory, never a gate. Reproducible from a seed. Self-contained
  (bundles its own profile engine, route fixture and verdict classifier).
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Misfit

Inject faults at Playwright's `route` layer — no application change needed — and
report which flows **degrade gracefully** and which **shatter**.

The output is a per-flow verdict, **not a pass/fail gate**. A flow that shatters
under a 5xx burst may be an accepted risk; the deliverable is that someone
looked and decided.

## Precondition — read this first

**Do not run `canary-misfit` against a system with no resilience mechanisms
implemented.** If nothing retries, times out or falls back, every flow shatters
and the report tells you only that resilience has not been built yet. Adopted
from harness's service-level `harness-chaos`, which states the same precondition
at its own layer. Implement retry/timeout/fallback behaviour first; this skill
measures what that behaviour does under pressure.

`harness-chaos` injects at the **service** boundary; `canary-misfit` injects at
the **browser** boundary. They are complementary, not alternatives, and share
the fault vocabulary below so a service-level and a browser-level run read as
one report.

## The degradation profile

Seeded and reproducible. The same `(seed, profile, request sequence)` always
makes the same decisions.

```jsonc
{
  "schema_version": 1,
  "name": "flaky-upstream",
  "seed": 1337,
  "budget_ms": 8000, // optional: a passing flow slower than this is `degraded`
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

| Kind      | Effect at the route layer                             | Required fields    |
| --------- | ----------------------------------------------------- | ------------------ |
| `latency` | delays the request before continuing                  | `delay_ms`         |
| `error`   | fulfils with a 4xx/5xx body (`burst` for consecutive) | `status` (400-599) |
| `abort`   | aborts the request with a Playwright error reason     | —                  |
| `network` | applies a named envelope as a delay                   | `profile`          |

Named network envelopes — `slow-3g`, `fast-3g`, `regional-edge`, `satellite` —
each resolve to `latency_ms` / `jitter_ms` / `loss_rate` / `bandwidth_kbps`.
**This vocabulary is shared with #858's load-scenario composer**, which attaches
the same envelopes at the protocol/load layer. One definition, two layers.

Faults are evaluated in declaration order; the first that matches and fires
wins. `rate` defaults to 1 (always), `match` defaults to `**`.

## Wiring (one step, once per suite)

```ts
// fixtures.ts
import { test as base } from '@playwright/test';
import { withMisfit } from 'canary/agents/skills/claude-code/canary-misfit/scripts/route_fixture/playwright-fixture.mjs';

export const test = withMisfit(base, {
  profilePath: 'misfit/flaky-upstream.json',
  ledgerPath: 'test-results/misfit-ledger.jsonl',
});
```

Every fault that fires is appended to the JSONL ledger, which is what the CLI
turns into verdicts.

**Composition with `canary-instrument` is optional and additive**: chain the
wrappers (`withMisfit(withTestSpan(base), …)`). Neither skill requires the
other, and neither reads the other's artifact.

## Invocation

```bash
# Resolve and print the profile without assessing anything:
canary skills run canary-misfit -- --profile misfit/flaky-upstream.json

# Per-flow verdicts from a run:
canary skills run canary-misfit -- \
  --profile misfit/flaky-upstream.json \
  --results test-results/results.json \
  --ledger test-results/misfit-ledger.jsonl \
  --out test-results/misfit.md

# Reproduce a reported failure exactly:
canary skills run canary-misfit -- --profile misfit/flaky-upstream.json --seed 1337 ...

# Usage (exits 0):
canary skills run canary-misfit -- --help
```

## Verdicts

| Flow outcome                                | Verdict       |
| ------------------------------------------- | ------------- |
| no fault was applied to any of its requests | `unexercised` |
| passed, no retry, within `budget_ms`        | `graceful`    |
| passed but retried, or over `budget_ms`     | `degraded`    |
| failed or timed out                         | `shattered`   |

`unexercised` flows are **excluded from the denominator**. A run where zero
flows had a fault injected prints `ABSTAINED:` and reports nothing else — "0
shattered" over zero exercised flows is the false green this rule exists to
prevent (#508).

## Exit codes

Advisory by default: **exit 0 whatever it finds**. Under `--strict`:

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | nothing shattered                        |
| 1    | at least one flow shattered              |
| 2    | usage error                              |
| 3    | abstained (no flow had a fault injected) |

## Reproducibility, precisely

The injection decision is a pure function of the seed, the fault id, and the
request identity (`METHOD url#ordinal`, where the ordinal counts repeats of that
method+url **within one flow**). It does **not** depend on arrival order, which
is what makes a parallel run reproducible. The consequence: a change to how many
times a flow calls a URL changes that flow's decisions, even at the same seed.

## Related skills

- `canary-instrument` — OTel correlation of tests to outbound requests; optional
  composition, no dependency either way.
- `canary-fail-fast` — aborts a broken run early and prints a loud digest.
- `canary-test-reporter` — the pass/fail summary of the same run.
