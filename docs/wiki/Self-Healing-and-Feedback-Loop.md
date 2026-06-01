# Self-Healing & Feedback Loop 🔄

Canary can diagnose a failing or flaky test and propose a fix. As of v3 this
runs through the Claude Code plugin — **not** an in-process orchestrator loop,
and with no API key.

## How it Works

1. **Generation:** the `canary-test-author` agent (`/canary-write-test`) writes
   a test based on your requirement, in your Claude Code session.
2. **Execution:** run the test with the deterministic CLI executor —
   `canary run <file> <framework>` — or your framework's own runner.
3. **Capture:** if it fails, copy the error output back into Claude Code.
4. **Self-Healing:** the `canary-test-healer` agent (`/canary-heal-test`)
   reads the failing code and error, forms a single root-cause hypothesis, and
   proposes a fix — using the host session, no provider key.
5. **Re-Verification:** apply the fix and re-run the test to confirm.

For *intermittent* failures specifically, use the `canary-flake-hunter` agent
(`/canary-debug-flake`), which classifies the flake (timing, ordering,
environment, selectors, etc.) and proposes a deterministic fix.

## Manual Run

Run any test file with Canary's executor (deterministic, no key):

```bash
canary run tests/generated/my_test.spec.ts playwright
```

## Safety Mechanisms

- **Subprocess Timeout:** all test executions have a 30-second timeout so a
  hanging test can't block the CLI.
- **Non-Interactive Execution:** Canary uses hardened flags (like `npx --yes`)
  so a run never stalls waiting for input.
- **Human in the loop:** healing happens in your Claude Code session — you
  review and apply each proposed fix rather than an autonomous loop rewriting
  files unattended.
