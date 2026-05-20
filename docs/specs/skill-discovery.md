---
project: oracle
version: 1
created: 2026-05-20
---

# Skill Discovery Convention

This spec defines how Oracle discovers skills at runtime, enabling downstream
overlay repositories to extend Oracle's behavior with zero application code.

## Background

Oracle ships bundled skills (slash commands, harness-prescriptive agents) that
live inside the `oracle-test-ai-agent` repository. Teams who need company-specific
test generation workflows — custom frameworks, internal conventions, house-style
assertions — should not fork Oracle. Instead they place skill files in a
well-known directory and Oracle discovers them at runtime.

This mirrors the `harness-engineering` ↔ `harness-capillary` relationship:
the engine is separate from the overlay. Extension is a filesystem convention,
not a Python entry-point or subclass.

## Skill File Format

Every discoverable skill is a Markdown file with YAML frontmatter:

```text
---
name: <skill-name>
description: One-line description shown in oracle skills list
---

# Skill title

Skill body — prescriptive instructions for the agent.
```

The `name` field is the identifier used for deduplication and override. The
`description` field is surfaced by `oracle skills list`.

## Bundled Skills

Oracle ships two layers of bundled skills:

| Location | Format | Purpose |
| --- | --- | --- |
| `agents/skills/oracle:*.md` | Flat `.md` | Claude Code slash commands (`/oracle:generate`, `/oracle:init`, `/oracle:migrate`) |
| `agents/skills/claude-code/<name>/SKILL.md` | Nested directory | Prescriptive harness skills invoked by harness agents |

## Local Overlay Convention

Local skills live in `.oracle/skills/` under any directory in the project tree:

```text
.oracle/
  config.json          # existing Oracle config (provider, key, etc.)
  skills/
    <skill-name>/
      SKILL.md         # required — skill content + frontmatter
```

Oracle walks from the current working directory up to the nearest `.git`
boundary, collecting every `.oracle/skills/` directory it finds along the way.
This means a skill placed at the repo root is visible from any subdirectory.

### Example overlay repository

An overlay repo (`oracle-capillary`) contains only skill directories — no
Python code, no `pyproject.toml`, no `oracle` dependency declaration:

```text
oracle-capillary/
  .oracle/
    skills/
      capillary-api-test/
        SKILL.md
      capillary-contract-test/
        SKILL.md
  README.md
```

When a developer clones `oracle-capillary` and installs `oracle-test-ai` (the
base), Oracle discovers the capillary skills from any subdirectory of the
checkout.

## Precedence Rules

1. Local overlay skills always win over bundled skills with the same `name`.
2. Among multiple `.oracle/skills/` directories found while walking to the git
   root, the one closest to CWD wins (most-specific wins).
3. Among bundled skills, slash-command skills (`oracle:*.md`) take precedence
   over harness prescriptive skills with the same name (the slash-command format
   is the primary Claude Code extension point).

## CLI Discovery

```bash
# List all discoverable skills from the current directory
oracle skills list

# Show file paths as well
oracle skills list --verbose
```

Output groups skills by source:

```text
Bundled skills:
  /oracle-add-framework  Add a new testing framework to Oracle's registry end-to-end.
  /oracle-generate-test  Generate a framework-appropriate test from a natural-language requirement.
  /oracle:generate       Generate tests for the file open in the editor.
  /oracle:init           Scaffold a test suite for the active project.
  /oracle:migrate        Migrate a harness-scaffolded test suite to Oracle's layout.

Local overlay skills (override bundled):
  /capillary-api-test    Generate Capillary-style API contract tests.
```

## Installation

Oracle is installable without cloning:

```bash
# Latest stable release
pipx install git+https://github.com/bri-stevenski/oracle-test-ai-agent@v0.2.0

# Specific tag
pipx install "git+https://github.com/bri-stevenski/oracle-test-ai-agent@v0.2.0"
```

Once PyPI publication is set up, `pipx install oracle-test-ai` will work
as the canonical install path.

## Out of Scope

- Skill execution from the CLI — skills are documentation for agents, not
  callable functions. The CLI executes Oracle's own pipeline (`oracle generate`,
  `oracle run`, etc.).
- Hot-reload of skills — discovery runs once per `oracle skills list` call.
- Remote skill registries — all discovery is filesystem-local.
