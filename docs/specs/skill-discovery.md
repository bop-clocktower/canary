---
project: oracle
version: 2
created: 2026-05-20
updated: 2026-05-21
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
cli: scripts/cli.py        # optional — see "Bundled Executable Code"
# or:
# entry: my_pkg.cli:main   # optional — alternative to cli, mutually exclusive
---

# Skill title

Skill body — prescriptive instructions for the agent.
```

The `name` field is the identifier used for deduplication and override. The
`description` field is surfaced by `oracle skills list`. The `cli` / `entry`
fields are optional and let a skill declare bundled executable code — see the
next section.

## Bundled Executable Code

Some skills ship more than prose. An overlay might need to emit company-style
templates, parse runtime artifacts, post results to an internal dashboard, or
run deterministic transforms that no LLM should re-derive. The Harness overlay
pattern (`harness-engineering` ↔ `harness-capillary`) handles this by letting
a skill directory ship a `scripts/` tree alongside `SKILL.md`. Oracle adopts
the same convention.

A skill that bundles executable code looks like:

```text
.oracle/skills/<name>/
  SKILL.md              # required — frontmatter declares cli or entry
  scripts/              # conventional location for bundled code
    cli.py              # or package.json + src/, pyproject.toml + …, …
    tests/
```

Two ways to declare the entry point in frontmatter — exactly one, never both:

- **`cli:`** — filesystem path, relative to the skill directory, of an
  executable script or binary. Oracle invokes it as a subprocess with CWD
  set to the skill directory so relative paths inside the bundled code
  resolve correctly. The script chooses its own runtime (`#!/usr/bin/env
  python3`, `#!/usr/bin/env node`, a compiled binary, etc.). This is the
  primary form — used by filesystem-local overlay skills.

- **`entry:`** — Python `module:callable` string. Oracle imports the
  module and calls the callable in-process with `argv` forwarded. Reserved
  for skills bundled as installed Python packages where Oracle is already
  running in a Python environment that has the module on `sys.path`.
  Oracle does **not** auto-install dependencies for `entry` skills.

The directory shape under `scripts/` is otherwise unstructured — overlay
maintainers pick the language and package layout that fits the work.
`scripts/` is convention, not enforcement; the only requirement is that
the path declared in `cli:` resolves inside the skill directory after
symlink resolution (see Security below).

### Discovery semantics

- Skills with `cli:` / `entry:` are discovered the same way as markdown-only
  skills (filesystem walk, precedence rules below).
- The markdown body of an executable skill is **still consumed by agents** —
  the executable is additive, not a replacement. An agent reading the skill
  to learn how to behave does not need to invoke the bundled code; a workflow
  that needs the deterministic behavior calls `oracle skills run <name>`.

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

An overlay repo contains only skill directories — no application code, no
`pyproject.toml` at the root, no `oracle` dependency declaration. Skills can
be markdown-only or ship bundled code via `scripts/`:

```text
oracle-capillary/
  .oracle/
    skills/
      capillary-api-test/
        SKILL.md                  # markdown-only: prescriptive guidance
      capillary-contract-test/
        SKILL.md
      capillary-dashboard-sink/
        SKILL.md                  # frontmatter: cli: scripts/cli.py
        scripts/
          cli.py
          pyproject.toml
          tests/
  README.md
```

When a developer clones the overlay and installs `oracle-test-ai` (the base),
Oracle discovers every skill from any subdirectory of the checkout. Markdown
skills are read as prose; code-bearing skills are invocable via
`oracle skills run`.

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

# Invoke a code-bearing skill's bundled cli/entry
oracle skills run <name> [-- arg1 arg2 ...]
```

`oracle skills list` groups skills by source and marks code-bearing skills
with `[cli]` or `[entry]` so the distinction from markdown-only skills is
visible at a glance:

```text
Bundled skills:
  /oracle-add-framework  Add a new testing framework to Oracle's registry end-to-end.
  /oracle-generate-test  Generate a framework-appropriate test from a natural-language requirement.
  /oracle:generate       Generate tests for the file open in the editor.
  /oracle:init           Scaffold a test suite for the active project.
  /oracle:migrate        Migrate a harness-scaffolded test suite to Oracle's layout.

Local overlay skills (override bundled):
  /capillary-api-test         Generate Capillary-style API contract tests.
  /capillary-dashboard-sink   Post test reports to an internal dashboard.  [cli]
```

`oracle skills run <name>` resolves the skill via the precedence rules,
verifies the declared `cli:`/`entry:` target is inside the skill directory,
and invokes it with the remaining args forwarded.

### CI safety

Discovery is automatic, but **execution of bundled code from a freshly cloned
overlay is not**. In non-interactive contexts (no TTY, or `CI=true` in the
environment), `oracle skills run` refuses to invoke `cli:`/`entry:` skills
unless the caller passes `--allow-executable-skills`. This prevents a
drive-by `git pull` of a malicious overlay from silently executing code on
the next CI run. Markdown skills are unaffected — discovery and prose
consumption work normally.

## Security

- `cli:` paths must resolve **inside the skill directory** after symlink
  resolution. Paths that escape (`..`, absolute paths, symlinks that point
  outside the skill dir) are rejected at discovery time with a clear error.
  The skill is still listed, but `oracle skills run` will fail.
- `entry:` is only honored when Oracle is running inside a Python environment
  that already has the module on `sys.path`. Oracle does not auto-install
  dependencies for entry skills.
- The bundled code's own runtime dependencies are the skill's responsibility
  to declare (`pyproject.toml`, `package.json`, etc.) and to install. Oracle
  does not manage them.
- In CI contexts, executable skills require `--allow-executable-skills` as
  described above.

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

- Hot-reload of skills — discovery runs once per `oracle skills` invocation.
- Remote skill registries — all discovery is filesystem-local.
- Cross-skill imports — each skill's bundled code is self-contained. A skill
  may not import from another skill's `scripts/` tree.
- Auto-installing skill runtime dependencies — `cli:` skills are responsible
  for declaring and installing their own deps via `pyproject.toml`,
  `package.json`, etc.

> **Note (version 1 → 2):** "Skill execution from the CLI" was previously
> listed as out of scope. Version 2 adds it via the `cli:` / `entry:`
> frontmatter fields described above, matching the Harness overlay pattern.
> Markdown-only skills behave identically to version 1 — the new fields are
> additive and optional.
