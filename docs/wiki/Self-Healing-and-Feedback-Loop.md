# Self-Healing & Feedback Loop 🔄

One of Oracle's most advanced features is its ability to learn from its own mistakes. The **Execution Feedback Loop** turns Oracle from a static generator into an autonomous engineer.

## How it Works

1. **Generation:** Oracle writes a test file based on your requirement.
2. **Execution:** Using the `--run` flag, Oracle immediately executes the test in a secure subprocess.
3. **Capture:** If the test fails (non-zero exit code), Oracle captures the `stderr` and the failing code.
4. **Self-Healing:** Oracle sends the error output back to the LLM, requesting a fix for the specific failure.
5. **Re-Verification:** The fixed code is rewritten to disk and executed again.

## Usage

### Auto-Healing on Generation
```bash
oracle generate "Create a playwright test for login" --run
```

### Manual Run
You can also run any test file manually using Oracle's knowledge:
```bash
oracle run tests/generated/my_test.spec.ts playwright
```

## Safety Mechanisms
- **1-Retry Limit:** To prevent infinite loops and token waste, the MVP self-healing loop is limited to one correction attempt.
- **Subprocess Timeout:** All test executions have a 30-second timeout to prevent "hanging" tests from blocking the CLI.
- **Non-Interactive Execution:** Oracle uses hardened flags (like `npx --yes`) to ensure it doesn't get stuck waiting for user input during a run.
