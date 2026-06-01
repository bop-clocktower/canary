---
name: canary:init
description: Scaffold a new test suite for a chosen framework using Oracle's initializer agent.
---

# canary:init

Invoke the `canary-initializer` agent to scaffold a test suite.

## Usage

```text
/canary:init [framework]
```

- If `[framework]` is provided (e.g. `/canary:init playwright`), pass
  it directly to `canary-initializer` — skip the framework-selection step.
- If omitted, `canary-initializer` will call `canary__list_frameworks`
  and prompt the user to choose.

## Prompt template for the agent

Provide this context to `canary-initializer`:

```text
Framework: <framework or "unspecified">
Target directory: <current working directory>

If framework is "unspecified", call canary__list_frameworks and ask the
user to choose before calling canary__init_suite.
```

## Success criteria

- `canary__init_suite` returns without error.
- The response lists at least one created file or directory.
- The user is reminded to install framework dependencies if applicable.
