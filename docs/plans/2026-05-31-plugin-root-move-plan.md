# Plan: Move Plugin to Repo Root

**Date:** 2026-05-31 | **Tasks:** 8 | **Time:** ~30 min |
**Integration Tier:** medium

## Goal

Move the Oracle Claude Code plugin from `plugins/oracle/` to the repo root so
`marketplace.json` can use a plain GitHub URL source, eliminating the
`git-subdir` format and its Node.js runtime sensitivity.

## Observable Truths

1. `/.claude-plugin/plugin.json` exists at repo root; `plugins/oracle/` does not.
2. `/agents/oracle-*.md`, `/commands/oracle-*.md`, `/hooks/*.py`, and `/voice/`
   exist at repo root.
3. `marketplace.json` `source` is `"https://github.com/bop-clocktower/canary"`
   (plain string, no `type`/`path` sub-fields).
4. `/plugin install oracle@oracle` succeeds on a machine without volta.
5. `harness validate` passes.
6. No file in the repo contains the string `plugins/oracle/`.

## File Map

```text
MOVE   plugins/oracle/.claude-plugin/plugin.json        → .claude-plugin/plugin.json
MOVE   plugins/oracle/.claude-plugin/hooks.json         → .claude-plugin/hooks.json
MOVE   plugins/oracle/.claude-plugin/schemas/           → .claude-plugin/schemas/
MOVE   plugins/oracle/agents/*                          → agents/
MOVE   plugins/oracle/commands/*                        → commands/
MOVE   plugins/oracle/hooks/*                           → hooks/
MOVE   plugins/oracle/voice/**                          → voice/
MODIFY .claude-plugin/marketplace.json
DELETE plugins/oracle/ (and plugins/ if empty)
MODIFY AGENTS.md
MODIFY tests/unit/test_hooks.py
MODIFY docs/roadmap.md
MODIFY docs/adr/0001-host-llm-generation-for-agents.md
MODIFY docs/adr/0002-self-heal-as-slash-command.md
MODIFY docs/plans/self-heal-migration.md
MODIFY docs/plans/host-llm-migration.md
MODIFY docs/specs/self-heal-migration.md
MODIFY docs/specs/host-llm-migration.md
MODIFY docs/changes/host-llm-migration/plans/2026-05-26-phase-1-plan.md
MODIFY docs/changes/host-llm-migration/plans/2026-05-26-phase-2-plan.md
MODIFY docs/changes/host-llm-migration/verification-2026-05-26.md
MODIFY docs/wiki/Troubleshooting.md
MODIFY docs/CANARY_LEARNINGS.md
```

## Tasks

### Task 1: Create branch and move .claude-plugin files

**Depends on:** none | **Files:** `.claude-plugin/plugin.json`,
`.claude-plugin/hooks.json`, `.claude-plugin/schemas/plugin.schema.json`

```bash
git checkout -b refactor/plugin-root-move

git mv plugins/oracle/.claude-plugin/plugin.json .claude-plugin/plugin.json
git mv plugins/oracle/.claude-plugin/hooks.json .claude-plugin/hooks.json
mkdir -p .claude-plugin/schemas
git mv plugins/oracle/.claude-plugin/schemas/plugin.schema.json \
  .claude-plugin/schemas/plugin.schema.json
rmdir plugins/oracle/.claude-plugin

harness validate
```

No logic changes. `plugin.json` `"hooks": "./.claude-plugin/hooks.json"` path
resolves correctly from repo root — no edit needed.

### Task 2: Move agents, commands, hooks, voice

**Depends on:** Task 1 |
**Files:** `agents/`, `commands/`, `hooks/`, `voice/`

```bash
# agents — root already has agents/skills/, oracle files go alongside it
git mv plugins/oracle/agents/oracle-flake-hunter.md    agents/
git mv plugins/oracle/agents/oracle-framework-advisor.md agents/
git mv plugins/oracle/agents/oracle-initializer.md     agents/
git mv plugins/oracle/agents/oracle-migrator.md        agents/
git mv plugins/oracle/agents/oracle-test-author.md     agents/
git mv plugins/oracle/agents/oracle-test-generator.md  agents/
git mv plugins/oracle/agents/oracle-test-healer.md     agents/
git mv plugins/oracle/agents/oracle-test-reviewer.md   agents/
rmdir plugins/oracle/agents

# commands
mkdir commands
git mv plugins/oracle/commands/oracle-debug-flake.md   commands/
git mv plugins/oracle/commands/oracle-heal-test.md     commands/
git mv plugins/oracle/commands/oracle-pick-framework.md commands/
git mv plugins/oracle/commands/oracle-review-test.md   commands/
git mv plugins/oracle/commands/oracle-write-test.md    commands/
rmdir plugins/oracle/commands

# hooks (Python scripts)
mkdir hooks
git mv plugins/oracle/hooks/block-no-verify.py    hooks/
git mv plugins/oracle/hooks/pre-compact-state.py  hooks/
git mv plugins/oracle/hooks/protect-config.py     hooks/
git mv plugins/oracle/hooks/quality-gate.py       hooks/
rmdir plugins/oracle/hooks

# voice (nested directories)
mkdir -p voice/profiles voice/quotes
git mv plugins/oracle/voice/discovery.md                 voice/
git mv plugins/oracle/voice/profiles/clocktower.md       voice/profiles/
git mv plugins/oracle/voice/quotes/birds-of-prey.md      voice/quotes/
git mv plugins/oracle/voice/quotes/house-aphorisms.md    voice/quotes/
rmdir plugins/oracle/voice/profiles plugins/oracle/voice/quotes plugins/oracle/voice

harness validate
```

### Task 3: Update marketplace.json and remove plugins/

**Depends on:** Task 2 | **Files:** `.claude-plugin/marketplace.json`

Edit `.claude-plugin/marketplace.json` — replace the `source` object with a
plain string:

```json
"source": "https://github.com/bop-clocktower/canary",
```

Full resulting `plugins` entry:

```json
{
  "name": "oracle",
  "source": "https://github.com/bop-clocktower/canary",
  "description": "Oracle plugin with four MVP personas (test-author, test-reviewer, framework-advisor, flake-hunter) and the harness MCP server. Personal-source build maintained by Bri Stevenski.",
  "version": "0.1.0",
  ...
}
```

Then remove the now-empty plugins tree:

```bash
rmdir plugins/oracle
rmdir plugins

harness validate
```

### Task 4: Update AGENTS.md and test_hooks.py

**Depends on:** Task 1 | **Files:** `AGENTS.md`, `tests/unit/test_hooks.py`

In `AGENTS.md` replace lines 149–150:

```markdown
- **Manifest:** [plugins/oracle/.claude-plugin/plugin.json](plugins/oracle/.claude-plugin/plugin.json)
- **Agents:** `plugins/oracle/.claude-plugin/agents/` — seven agent definitions:
```

with:

```markdown
- **Manifest:** [.claude-plugin/plugin.json](.claude-plugin/plugin.json)
- **Agents:** `agents/` — seven agent definitions:
```

In `tests/unit/test_hooks.py` update the module docstring from:
`"""Unit tests for plugins/oracle/hooks/*.py hook scripts.`
to:
`"""Unit tests for hooks/*.py hook scripts.`

```bash
harness validate
```

### Task 5: Bulk path rewrite — historical docs (ADRs, plans, specs, changes/)

**Depends on:** none | **Files:** docs/adr/\*, docs/plans/\*, docs/specs/\*,
docs/changes/\*\*/\*

All these files reference `plugins/oracle/` paths that map cleanly via
`plugins/oracle/` → `""`. Run a single sed pass, then fix the one AGENTS.md
pre-existing error (already handled in Task 4):

```bash
FILES=(
  docs/adr/0001-host-llm-generation-for-agents.md
  docs/adr/0002-self-heal-as-slash-command.md
  docs/plans/self-heal-migration.md
  docs/plans/host-llm-migration.md
  docs/specs/self-heal-migration.md
  docs/specs/host-llm-migration.md
  docs/changes/host-llm-migration/plans/2026-05-26-phase-1-plan.md
  docs/changes/host-llm-migration/plans/2026-05-26-phase-2-plan.md
  docs/changes/host-llm-migration/verification-2026-05-26.md
)
for f in "${FILES[@]}"; do
  sed -i '' 's|plugins/oracle/||g' "$f"
done

# Verify no remaining references
grep -r "plugins/oracle" docs/adr docs/plans docs/specs docs/changes \
  && echo "REMAINING REFS — fix manually" || echo "clean"

harness validate
```

### Task 6: Update docs/roadmap.md + add canary rename item

**Depends on:** Task 5 | **Files:** `docs/roadmap.md`

```bash
sed -i '' 's|plugins/oracle/||g' docs/roadmap.md
```

Then add the canary rename item under **Future Work** (before the first future
item), with a sequencing note that plugin files are now at root (not
`plugins/oracle/`):

```markdown
### Rename oracle → canary

- **Status:** planned
- **Issue:** none yet
- **Spec:** none
- **Summary:** Rename the tool from Oracle to Canary to avoid collision with
  Oracle Corporation. Package: `oracle-test-ai` → `canary-test-ai`. CLI entry
  point: `oracle` → `canary`. MCP server: `FastMCP("oracle")` → `FastMCP("canary")`;
  tool names update from `oracle__*` to `canary__*`; agent `allowed-tools:`
  frontmatter updates accordingly. Plugin name/manifest. All agent, command,
  and skill files renamed from `oracle-*` to `canary-*`. Doc bulk pass.
  Voice files (Clocktower profile, Birds of Prey quotes, house aphorisms) are
  **unchanged** — the Clocktower/Barbara Gordon persona is correct as written;
  the character framing does not depend on the tool name.
  **Sequencing note:** plugin files were moved to repo root in PR
  `refactor/plugin-root-move` — the rename targets root paths (`agents/`,
  `commands/`, `hooks/`), not `plugins/oracle/`.
- **Blockers:** none
- **Plan:** none
```

```bash
harness validate
```

### Task 7: Update Troubleshooting.md and CANARY_LEARNINGS.md

**Depends on:** Task 6 | **Files:** `docs/wiki/Troubleshooting.md`,
`docs/CANARY_LEARNINGS.md`

In `docs/wiki/Troubleshooting.md`, update the "Plugin Install Fails" section
added in PR #176. Change the explanation from "Node version mismatch" to the
root cause being fixed, but keep the volta fix for users on older checkouts:

Replace the section body with:

```markdown
**Note:** This error is resolved in the current repo — the plugin source was
moved to the repo root (eliminating the `git-subdir` format that required a
specific Node runtime). If you are on an older checkout or a fork that still
uses `git-subdir`, install Volta to fix the Node version:

```bash
brew install volta
volta install node
```

In `docs/CANARY_LEARNINGS.md`, update entry #11:

Replace the body of entry `## 11.` with:

```markdown
## 11. Plugin source format drives CC install compatibility

The CC marketplace `source` field must be a plain GitHub URL when the plugin
lives at the repo root. The `git-subdir` object format (for subdirectory
plugins) requires a specific Node.js runtime version to parse correctly —
installing Volta was the workaround, but moving the plugin to the repo root
eliminates the dependency entirely. Rule: keep plugin files at the repo root
so the source can be `"https://github.com/owner/repo"`.
```

```bash
harness validate
```

### Task 8: Final validate and commit

**Depends on:** Tasks 1–7 | **Files:** all changed

```bash
# Confirm no plugins/oracle/ references remain anywhere
grep -r "plugins/oracle" . --include="*.md" --include="*.json" --include="*.py" \
  --include="*.yml" --exclude-dir=".git" \
  && echo "REMAINING — fix before commit" || echo "clean"

harness validate
harness check-deps

git add -A
git commit -m "refactor: move plugin from plugins/oracle/ to repo root

Plain GitHub URL in marketplace.json eliminates git-subdir format
and the Node runtime version sensitivity it caused. Plugin files
are now at repo root alongside the marketplace descriptor.

Closes #175 root cause (volta workaround no longer needed).
Adds oracle→canary rename to roadmap."
```

Then open PR targeting `main`.

## Uncertainties

- `[ASSUMPTION]` `plugin.json` `"hooks": "./.claude-plugin/hooks.json"` resolves
  from repo root — verified by reading the file; no change needed.
- `[DEFERRABLE]` Whether `/plugin install oracle@oracle` needs a live test before
  merge — add `[checkpoint:human-verify]` after Task 3 if desired.
