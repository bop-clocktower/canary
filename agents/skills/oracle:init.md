---
name: oracle:init
description: Scaffold a new test suite for a chosen framework using Oracle's initializer agent.
---

# oracle:init

Invoke the `oracle-initializer` agent to scaffold a test suite.

## Usage

```
/oracle:init [framework]
```

- If `[framework]` is provided (e.g. `/oracle:init playwright`), pass
  it directly to `oracle-initializer` — skip the framework-selection step.
- If omitted, `oracle-initializer` will call `oracle__list_frameworks`
  and prompt the user to choose.

## Prompt template for the agent

Provide this context to `oracle-initializer`:

```
Framework: <framework or "unspecified">
Target directory: <current working directory>

If framework is "unspecified", call oracle__list_frameworks and ask the
user to choose before calling oracle__init_suite.
```

## Success criteria

- `oracle__init_suite` returns without error.
- The response lists at least one created file or directory.
- The user is reminded to install framework dependencies if applicable.
