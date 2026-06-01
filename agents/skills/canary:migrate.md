---
name: canary:migrate
description: Migrate a harness-scaffolded test suite to Canary's layout, optionally deploying overlay skills.
---

# canary:migrate

Invoke the `canary-migrator` agent against the current working directory.

## Usage

```text
/canary:migrate
/canary:migrate --overlay /path/to/company-overlay
```

The agent always runs a dry-run first and requires explicit confirmation
before writing any files.

## Options

| Flag | Description |
| --- | --- |
| `--overlay <path>` | Path to an overlay repo whose `.canary/skills/` are deployed into the target. Skills are filtered by `deploy_to` frontmatter matching the detected project shape. |
| `--framework <name>` | Override auto-detected framework (playwright, vitest, pytest, k6). |

## Skill deployment

When `--overlay` is provided, skills with `deploy_to` values matching the
detected project shape are copied into the target's `.canary/skills/`. Skills
already present are skipped. Dry-run shows what would be copied without
writing anything.

Example: an API test repo (`shape=api`) with `--overlay path/to/acme-overlay`
receives all skills tagged `deploy_to: [api]` or `deploy_to: [all]`.

## Prompt template for the agent

Provide this context to `canary-migrator`:

```text
Target directory: <current working directory>
Overlay (if applicable): <overlay path or "none">

1. Run canary migrate --overlay <overlay> with apply=false and show the
   dry-run plan, including which skills would be deployed.
2. Ask the user to confirm before applying.
3. On confirmation, run canary migrate --overlay <overlay> with apply=true.
4. Report created files, deployed skills, skipped files, and manual follow-ups.
```

## Success criteria

- Dry-run completes without error.
- User explicitly confirmed before apply was called.
- Final response lists created files, deployed skills, and required manual
  follow-ups.
- If no harness project is detected, the agent surfaces the error and stops.
