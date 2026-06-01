# Canary Examples

Runnable scenarios showing what Canary can do. Each example is **prompt-only**:
the directory contains the prompt to give Canary, the framework Canary should
pick, and the next steps after generation. No generated test files are committed
— re-run `canary generate` locally to produce fresh output.

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
| [feedback-workflow](feedback-workflow/)           | Flow | —          | Demonstrates the feedback hint + `canary feedback` |

## Prerequisites

Before running any example, install Canary as a Claude Code plugin.
See [Getting Started](../docs/wiki/Getting-Started.md).

For the mock provider (no API key, no real LLM call):

```bash
export CANARY_LLM_PROVIDER=mock
```

The mock provider always returns the same stub test, so generated output won't
match the example descriptions — useful only to confirm the CLI works
end-to-end.

## Running an example

```bash
cd examples/playwright-e2e-login
cat README.md                     # read the scenario
canary generate "$(cat prompt.txt)" --run
```

Each example's `README.md` also covers framework-specific install steps (npm
packages, browser binaries, Python deps, k6 install).

## Tips for adapting

The example prompts are deliberately generic so they generate against public
placeholder endpoints. To make them useful for **your project**:

- Paste your real endpoint URL, request shape, and auth pattern into the prompt
  — Canary has no internal context about your codebase unless you provide it
  (see [Known Limitations](../docs/wiki/Known-Limitations.md))
- Run `canary generate` from inside your project tree so Canary picks up
  existing test conventions
- Use `@canary-test-author` in Claude Code for multi-turn refinement on top of
  the generated draft

## Related

- [CLI Reference](../docs/wiki/CLI-Reference.md)
- [Writing Good Prompts](../docs/wiki/Writing-Good-Prompts.md)
- [Plugin Agents](../docs/wiki/Plugin-Agents.md)
