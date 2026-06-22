# Canary Examples

Runnable scenarios showing what Canary can do. Each example is **prompt-only**:
the directory contains the prompt to give Canary, the framework Canary should
pick, and the next steps after generation. No generated test files are committed
— re-run `/canary-write-test` in Claude Code to produce fresh output.

> Why prompt-only? Generated tests drift as Canary's models and templates
> change. Committing them would create stale, misleading reference material. The
> prompts and expected shape stay stable; the actual code is whatever Canary
> picks today.

## Catalog

| Example                                           | Type | Framework  | What it demonstrates                               |
| ------------------------------------------------- | ---- | ---------- | -------------------------------------------------- |
| [playwright-e2e-login](playwright-e2e-login/)     | E2E  | Playwright | Browser-level test of a login form                 |
| [pytest-api-checkout](pytest-api-checkout/)       | API  | Pytest     | HTTP-level test of a checkout endpoint             |
| [vitest-unit-validation](vitest-unit-validation/) | Unit | Vitest     | Pure unit test of a validation helper              |
| [k6-perf-checkout](k6-perf-checkout/)             | Perf | k6         | Load test holding 50 RPS for 30s                   |

## Real-world function examples

Domain-logic scenarios where you start from a function signature and let
Canary design the test coverage — not from a URL or framework mechanic.

| Example | Type | Framework | What it demonstrates |
| ------- | ---- | --------- | -------------------- |
| [lego-tracker-reconcile-collection](realworld-functions/lego-tracker-reconcile-collection/) | Unit | Pytest | Reconcile two LEGO set lists into matched / local-only / api-only |
| [price-normalizer](realworld-functions/price-normalizer/) | Unit | Vitest | Parse mixed-format price strings (US, EU, bare) into a canonical struct |
| [subscription-expiry-checker](realworld-functions/subscription-expiry-checker/) | Unit | Pytest | Bucket subscriptions into expired / expiring-soon / active by date |
| [access-policy-evaluator](realworld-functions/access-policy-evaluator/) | Unit | Pytest | RBAC check — roles × actions with wildcard grants and role ordering |
| [interval-merger](realworld-functions/interval-merger/) | Unit | Vitest | Merge overlapping / adjacent ranges into a sorted non-overlapping set |
| [semver-compare](realworld-functions/semver-compare/) | Unit | Vitest | Order semver strings — prerelease, identifier, and build-metadata rules |
| [tax-bracket-calculator](realworld-functions/tax-bracket-calculator/) | Unit | Pytest | Marginal tax across progressive brackets with boundary and reject cases |

See [realworld-functions/README.md](realworld-functions/README.md) for the
rationale and how to add more.

## Prerequisites

Before running any example, install Canary as a Claude Code plugin.
See [Getting Started](../docs/wiki/Getting-Started.md). No API key is
required — generation runs through your Claude Code session.

## Running an example

```bash
cd examples/playwright-e2e-login
cat README.md                     # read the scenario
```

Then, in Claude Code, generate the test from the scenario prompt:

```text
/canary-write-test  <paste the contents of prompt.txt>
```

Each example's `README.md` also covers framework-specific install steps (npm
packages, browser binaries, Python deps, k6 install).

## Tips for adapting

The example prompts are deliberately generic so they generate against public
placeholder endpoints. To make them useful for **your project**:

- Paste your real endpoint URL, request shape, and auth pattern into the prompt
  — Canary has no internal context about your codebase unless you provide it
  (see [Known Limitations](../docs/wiki/Known-Limitations.md))
- Run `/canary-write-test` from inside your project tree so Canary picks up
  existing test conventions
- Use `@canary-test-author` in Claude Code for multi-turn refinement on top of
  the generated draft

## Related

- [Getting Started](../docs/wiki/Getting-Started.md)
- [Writing Good Prompts](../docs/wiki/Writing-Good-Prompts.md)
- [Plugin Agents](../docs/wiki/Plugin-Agents.md)
