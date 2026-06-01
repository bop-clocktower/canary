# Self-Healing & Feedback Loop 🔄

One of Canary's most advanced features is its ability to learn from its
own mistakes. The **Execution Feedback Loop** turns Canary from a
static generator into an autonomous engineer.

## How it Works

1. **Generation:** Canary writes a test file based on your requirement.
2. **Execution:** Using the `--run` flag, Canary immediately executes
   the test in a secure subprocess.
3. **Capture:** If the test fails (non-zero exit code), Canary captures
   the `stderr` and the failing code.
4. **Self-Healing:** Canary sends the error output back to the LLM,
   requesting a fix for the specific failure.
5. **Re-Verification:** The fixed code is rewritten to disk and
   executed again.

## Usage

### Auto-Healing on Generation

```bash
canary generate "Create a playwright test for login" --run
```

### Manual Run

You can also run any test file manually using Canary's knowledge:

```bash
canary run tests/generated/my_test.spec.ts playwright
```

## Safety Mechanisms

- **1-Retry Limit:** To prevent infinite loops and token waste, the MVP
  self-healing loop is limited to one correction attempt.
- **Subprocess Timeout:** All test executions have a 30-second timeout
  to prevent "hanging" tests from blocking the CLI.
- **Non-Interactive Execution:** Canary uses hardened flags (like
  `npx --yes`) to ensure it doesn't get stuck waiting for user input
  during a run.
