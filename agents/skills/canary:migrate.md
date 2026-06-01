---
name: canary:migrate
description: Migrate a harness-scaffolded test suite to Canary's layout with a confirm-before-apply flow.
---

# canary:migrate

Invoke the `canary-migrator` agent against the current working directory.

## Usage

```text
/canary:migrate
```

The agent always runs a dry-run first and requires explicit confirmation
before writing any files.

## Prompt template for the agent

Provide this context to `canary-migrator`:

```text
Target directory: <current working directory>

1. Run canary__migrate with apply=false and show the dry-run plan.
2. Ask the user to confirm before applying.
3. On confirmation, run canary__migrate with apply=true.
4. Report created files, skipped files, and manual follow-ups.
```

## Success criteria

- Dry-run completes without error.
- User explicitly confirmed before apply was called.
- Final response lists all created files and required manual follow-ups.
- If no harness project is detected, the agent surfaces the error and stops.
