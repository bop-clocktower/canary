---
name: canary:generate
description: Generate a framework-appropriate test for the active editor file using Canary's analysis pipeline.
---

# canary:generate

Invoke the `canary-test-generator` agent with the active editor file as
the analysis target.

## Usage

```text
/canary:generate [file_path]
```

If `file_path` is omitted, use the currently open file in the editor.

## Prompt template for the agent

Provide this context to `canary-test-generator`:

```text
Target file: <file_path>

Analysis instructions:
1. Call canary__analyze_file on the target file.
2. Use the returned framework, imports, functions, and context_snippets
   to write tests that:
   - Cover every public function listed in `functions`
   - Mirror the import style from `imports`
   - Follow naming conventions inferred from `context_snippets`
   - Use the assertion style standard for the detected framework
     (e.g. `expect().toBe()` for Playwright/Vitest, `assert` for pytest)
3. Write the test file adjacent to the source file, e.g.:
   - src/auth/login.ts  →  tests/auth/login.spec.ts
   - agent/core/util.py →  tests/unit/test_util.py
4. Run the test file and fix failures (up to 3 attempts).
5. Report the final test file path and pass/fail status.
```

## Success criteria

- The generated test file exists at the expected path.
- `canary__run_tests` returns `exit_code == 0` on the final attempt.
- If tests could not be made to pass after 3 attempts, the agent
  reports the last failure output and the test file path.
