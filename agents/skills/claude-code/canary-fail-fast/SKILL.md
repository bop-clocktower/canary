---
name: canary-fail-fast
description:
  Surface test failures fast and loud — audit a Playwright config for fail-fast
  knobs (maxFailures/forbidOnly/retries) and print a loud, categorized failure
  digest to the CI log + ::error annotations at run end, failing the step so the
  signal can't be missed. Self-contained (bundles its own Playwright JSON parser
  and failure categorizer).
cli: scripts/cli.py
requires: [python3>=3.10]
---

# Canary Fail-Fast

Make test failures **fast** (abort a broken run early) and **loud** (surface in
the CI log + Checks, not a file). Two halves:

1. **Fail-fast config audit** — flags the absence of `maxFailures`,
   `forbidOnly`, and `retries` in a `playwright.config.*`.
2. **Loud run-end digest** — a terse, categorized failure summary to stdout +
   `::error` annotations, with a non-zero exit.

Self-contained: it bundles a minimal Playwright JSON parser and the failure
categorizer, so it has no dependency on any other skill.

## Fail-fast config (paste into `playwright.config.ts`)

```ts
export default defineConfig({
  // Fail fast in CI: abort once enough has clearly broken, never on local runs.
  forbidOnly: !!process.env.CI, // a stray test.only fails the build
  maxFailures: process.env.CI ? 10 : 0, // stop the run after 10 failures in CI
  retries: process.env.CI ? 2 : 0, // absorb flakes in CI; surface them locally
  // ...your existing config
});
```

## Invocation

```bash
# Loud failure digest from a Playwright JSON run (exits non-zero on failures):
canary skills run canary-fail-fast -- --results test-results/results.json

# Audit the fail-fast config:
canary skills run canary-fail-fast -- --config playwright.config.ts

# Both at once:
canary skills run canary-fail-fast -- \
  --results test-results/results.json \
  --config playwright.config.ts
```

At least one of `--results` / `--config` is required. The digest exits `1` when
any test failed (so the CI step fails); the config audit alone never fails the
build.

## CI wiring (GitHub Actions)

Run after the Playwright step with `if: always()` so the digest surfaces even
when the test step already failed:

```yaml
- name: Run Playwright
  run:
    npx playwright test --reporter=json --output-file=test-results/results.json

- name: Fail-fast digest
  if: always()
  run: |
    canary skills run canary-fail-fast -- \
      --results test-results/results.json
```
