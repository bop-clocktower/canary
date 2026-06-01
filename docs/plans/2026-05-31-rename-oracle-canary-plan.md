# Plan: Rename oracle → canary

**Date:** 2026-05-31 | **Tasks:** 11 | **Time:** ~51 min |
**Integration Tier:** large

## Goal

Rename oracle → canary across every code-bearing file so `canary version`,
`canary recommend`, and `/plugin install canary@canary` all work before the
company demo this week.

## Observable Truths

1. `pip install -e . && canary version` succeeds.
2. `canary recommend "test the login flow"` runs without error.
3. `python -m unittest discover tests/unit -q` — all tests pass.
4. `harness validate` passes.
5. Plugin manifest validates against schema — `plugin.json` `"name"` is
   `"canary"` and passes `jsonschema.validate`.
6. `agents/canary-*.md`, `commands/canary-*.md`, `agents/skills/canary:*.md`
   exist; `oracle-*` equivalents do not.
7. No `.oracle/` paths remain in Python source; `.canary/` used throughout.

## Not renamed

- Voice files (`voice/profiles/clocktower.md`, `voice/quotes/*`,
  `voice/discovery.md`) — Clocktower persona is correct as written.
- GitHub repo name (`oracle-test-ai-agent`) — deferred to post-demo.
- `harness.config.json` `"repo"` field — tracks the GitHub repo, unchanged.

## File Map

```text
MODIFY  pyproject.toml
MODIFY  agent/mcp_server.py
MODIFY  .claude-plugin/plugin.json
MODIFY  .claude-plugin/marketplace.json
RENAME  agents/oracle-*.md             → agents/canary-*.md  (8 files)
MODIFY  agents/canary-*.md             (frontmatter + tool refs)
RENAME  commands/oracle-*.md           → commands/canary-*.md  (5 files)
MODIFY  commands/canary-*.md           (allowed-tools)
RENAME  agents/skills/oracle:*.md      → agents/skills/canary:*.md  (3 files)
MODIFY  agents/skills/canary:*.md      (name + tool + agent refs)
MODIFY  agents/skills/README.md
MODIFY  agent/cli.py
MODIFY  agent/core/ticket_updater.py
MODIFY  agent/core/workflow_discovery.py
MODIFY  agent/core/skill_registry.py
MODIFY  .gitignore
MODIFY  tests/unit/test_skill_registry.py
MODIFY  tests/unit/test_mcp_server.py
MODIFY  harness.config.json
MODIFY  AGENTS.md
MODIFY  README.md
MODIFY  docs/wiki/*.md  (bulk)
MODIFY  docs/specs/*.md  (bulk)
MODIFY  docs/roadmap.md
```

## Tasks

### Task 1: Create branch

**Depends on:** none | **Files:** none

```bash
git checkout -b feat/rename-oracle-to-canary
harness validate
```

### Task 2: pyproject.toml — package identity and version bump

**Depends on:** Task 1 | **Files:** `pyproject.toml`

Edit `pyproject.toml`:

- `name = "oracle-test-ai"` → `name = "canary-test-ai"`
- `version = "3.0.0"` → `version = "3.1.0"`
- `oracle = "agent.cli:app"` → `canary = "agent.cli:app"`
- `oracle-mcp = "agent.mcp_server:main"` → `canary-mcp = "agent.mcp_server:main"`

```bash
harness validate
git add pyproject.toml
git commit -m "chore(rename): bump package to canary-test-ai 3.1.0"
```

### Task 3: agent/mcp_server.py — server name and tool function names

**Depends on:** Task 2 | **Files:** `agent/mcp_server.py`

```bash
sed -i '' \
  's/FastMCP("oracle")/FastMCP("canary")/g;
   s/def oracle__/def canary__/g;
   s/oracle-mcp/canary-mcp/g' \
  agent/mcp_server.py
```

Verify six tool functions renamed (`canary__analyze_file`,
`canary__write_test_file`, `canary__run_tests`, `canary__init_suite`,
`canary__list_frameworks`, `canary__migrate`):

```bash
grep "def canary__" agent/mcp_server.py   # expect 6 lines
grep "def oracle__" agent/mcp_server.py   # expect 0 lines
harness validate
git add agent/mcp_server.py
git commit -m "chore(rename): rename MCP server and tool functions to canary"
```

### Task 4: Plugin manifests — plugin.json and marketplace.json

**Depends on:** Task 3 | **Files:** `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`

In `.claude-plugin/plugin.json`:

- `"name": "oracle"` → `"name": "canary"`
- `"oracle-mcp":` key → `"canary-mcp":`
- `"command": "oracle-mcp"` → `"command": "canary-mcp"`

In `.claude-plugin/marketplace.json`:

- `"name": "oracle"` (top-level, line 3) → `"name": "canary"`
- `"name": "oracle"` (plugin entry, line 11) → `"name": "canary"`
- description: `"Oracle — AI-powered test automation..."` →
  `"Canary — AI-powered test automation..."`

```bash
harness validate
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(rename): rename plugin manifests to canary"
```

### Task 5: Agent files — rename 8 files and update content

**Depends on:** Task 4 | **Files:** `agents/canary-*.md`

```bash
# Rename
for f in agents/oracle-*.md; do
  git mv "$f" "${f/agents\/oracle-/agents\/canary-}"
done

# Update frontmatter name field
sed -i '' 's/^name: oracle-/name: canary-/' agents/canary-*.md

# Update MCP tool refs — double-prefix first, then single
sed -i '' 's/mcp__oracle__oracle__/mcp__canary__canary__/g' agents/canary-*.md
sed -i '' 's/mcp__oracle__/mcp__canary__canary__/g' agents/canary-*.md

# Update bare tool name refs (oracle__ in prose/steps)
sed -i '' 's/oracle__/canary__/g' agents/canary-*.md

# Update cross-agent references in prose
sed -i '' \
  's/oracle-test-author/canary-test-author/g;
   s/oracle-test-reviewer/canary-test-reviewer/g;
   s/oracle-test-generator/canary-test-generator/g;
   s/oracle-test-healer/canary-test-healer/g;
   s/oracle-flake-hunter/canary-flake-hunter/g;
   s/oracle-framework-advisor/canary-framework-advisor/g;
   s/oracle-initializer/canary-initializer/g;
   s/oracle-migrator/canary-migrator/g' \
  agents/canary-*.md

# Update config dir path referenced in agent prose
sed -i '' 's|\.oracle/|\.canary/|g' agents/canary-*.md

# Verify
grep "mcp__oracle" agents/canary-*.md && echo "REMAINING REFS" || echo "clean"
harness validate
git add agents/
git commit -m "chore(rename): rename agent files oracle-* → canary-*"
```

### Task 6: Command files — rename 5 files and update content

**Depends on:** Task 5 | **Files:** `commands/canary-*.md`

```bash
for f in commands/oracle-*.md; do
  git mv "$f" "${f/commands\/oracle-/commands\/canary-}"
done

# Update allowed-tools mcp refs
sed -i '' 's/mcp__oracle__oracle__/mcp__canary__canary__/g' commands/canary-*.md
sed -i '' 's/mcp__oracle__/mcp__canary__canary__/g' commands/canary-*.md

# Update agent name references and slash command names in prose
sed -i '' \
  's/oracle-test-author/canary-test-author/g;
   s/oracle-test-healer/canary-test-healer/g;
   s/oracle-write-test/canary-write-test/g;
   s/oracle-heal-test/canary-heal-test/g;
   s/oracle-review-test/canary-review-test/g;
   s/oracle-debug-flake/canary-debug-flake/g;
   s/oracle-pick-framework/canary-pick-framework/g' \
  commands/canary-*.md

# Update heading names (## oracle-write-test → ## canary-write-test)
sed -i '' 's/^# oracle-/# canary-/' commands/canary-*.md

grep "oracle" commands/canary-*.md && echo "REMAINING" || echo "clean"
harness validate
git add commands/
git commit -m "chore(rename): rename command files oracle-* → canary-*"
```

### Task 7: Skill files — rename 3 files and update content + README

**Depends on:** Task 6 | **Files:** `agents/skills/canary:*.md`,
`agents/skills/README.md`

```bash
git mv "agents/skills/oracle:generate.md" "agents/skills/canary:generate.md"
git mv "agents/skills/oracle:init.md"     "agents/skills/canary:init.md"
git mv "agents/skills/oracle:migrate.md"  "agents/skills/canary:migrate.md"

# Update name frontmatter and all oracle refs inside
sed -i '' \
  's/^name: oracle:/name: canary:/g;
   s/oracle:generate/canary:generate/g;
   s/oracle:init/canary:init/g;
   s/oracle:migrate/canary:migrate/g;
   s/oracle-test-generator/canary-test-generator/g;
   s/oracle-initializer/canary-initializer/g;
   s/oracle-migrator/canary-migrator/g;
   s/oracle__/canary__/g' \
  "agents/skills/canary:generate.md" \
  "agents/skills/canary:init.md" \
  "agents/skills/canary:migrate.md"

# README
sed -i '' \
  's/oracle:/canary:/g;
   s/oracle-generate-test/canary-generate-test/g;
   s/oracle-promote-test/canary-promote-test/g;
   s/oracle-add-framework/canary-add-framework/g;
   s/oracle-setup-harness/canary-setup-harness/g' \
  agents/skills/README.md

harness validate
git add agents/skills/
git commit -m "chore(rename): rename skill files oracle:* → canary:*"
```

### Task 8: Config dir — Python source, .gitignore, harness.config.json

**Depends on:** Task 7 |
**Files:** `agent/cli.py`, `agent/core/ticket_updater.py`,
`agent/core/workflow_discovery.py`, `agent/core/skill_registry.py`,
`.gitignore`, `harness.config.json`

```bash
# Python source: .oracle/ paths and oracle_dir variable names
sed -i '' \
  's|\.oracle/|\.canary/|g;
   s/oracle_dir/canary_dir/g;
   s/".oracle"/"\.canary"/g' \
  agent/cli.py \
  agent/core/ticket_updater.py \
  agent/core/workflow_discovery.py \
  agent/core/skill_registry.py

# .gitignore
sed -i '' 's|\.oracle/|\.canary/|g' .gitignore

# harness.config.json — name field only (repo field unchanged)
sed -i '' 's/"name": "oracle"/"name": "canary"/' harness.config.json

harness validate
git add agent/cli.py agent/core/ticket_updater.py \
        agent/core/workflow_discovery.py agent/core/skill_registry.py \
        .gitignore harness.config.json
git commit -m "chore(rename): .oracle/ → .canary/ in Python source and config"
```

### Task 9: Tests — test_skill_registry.py and test_mcp_server.py

**Depends on:** Task 8 |
**Files:** `tests/unit/test_skill_registry.py`, `tests/unit/test_mcp_server.py`

```bash
# test_skill_registry: .oracle/skills → .canary/skills paths
sed -i '' 's|\.oracle/skills|\.canary/skills|g' tests/unit/test_skill_registry.py

# test_mcp_server: oracle__ comment references
sed -i '' 's/# oracle__/# canary__/g' tests/unit/test_mcp_server.py

python -m unittest discover tests/unit -q  # must pass
harness validate
git add tests/unit/test_skill_registry.py tests/unit/test_mcp_server.py
git commit -m "chore(rename): update test paths and comments for canary"
```

### Task 10: AGENTS.md and README.md

**Depends on:** Task 9 | **Files:** `AGENTS.md`, `README.md`

```bash
# AGENTS.md — CLI commands, plugin install, agent/slash-command names
sed -i '' \
  's/oracle-test-ai/canary-test-ai/g;
   s/oracle-mcp/canary-mcp/g;
   s/oracle-test-author/canary-test-author/g;
   s/oracle-test-reviewer/canary-test-reviewer/g;
   s/oracle-test-generator/canary-test-generator/g;
   s/oracle-test-healer/canary-test-healer/g;
   s/oracle-flake-hunter/canary-flake-hunter/g;
   s/oracle-framework-advisor/canary-framework-advisor/g;
   s/oracle-initializer/canary-initializer/g;
   s/oracle-migrator/canary-migrator/g;
   s/oracle:generate/canary:generate/g;
   s/oracle:init/canary:init/g;
   s/oracle:migrate/canary:migrate/g;
   s/\/oracle-write-test/\/canary-write-test/g;
   s/\/oracle-review-test/\/canary-review-test/g;
   s/\/oracle-heal-test/\/canary-heal-test/g;
   s/\/oracle-debug-flake/\/canary-debug-flake/g;
   s/\/oracle-pick-framework/\/canary-pick-framework/g;
   s|\.oracle/|\.canary/|g' \
  AGENTS.md

# README.md — title, pipx install, usage, plugin install
sed -i '' \
  's/# Oracle 🦇/# Canary 🦇/g;
   s/oracle-test-ai/canary-test-ai/g;
   s/oracle generate/canary generate/g;
   s/oracle version/canary version/g;
   s/oracle recommend/canary recommend/g;
   s/oracle@oracle/canary@canary/g;
   s/**Oracle** is/**Canary** is/g;
   s/Oracle defaults/Canary defaults/g;
   s/Oracle will/Canary will/g;
   s/Oracle always/Canary always/g' \
  README.md

harness validate
git add AGENTS.md README.md
git commit -m "chore(rename): update AGENTS.md and README.md for canary"
```

### Task 11: Docs bulk pass — wiki, specs, roadmap

**Depends on:** Task 10 | **Files:** `docs/wiki/*.md`, `docs/specs/*.md`,
`docs/roadmap.md`

```bash
DOCS=(docs/wiki/*.md docs/specs/*.md docs/roadmap.md)

# CLI commands, agent names, slash commands, config dir
sed -i '' \
  's/oracle generate/canary generate/g;
   s/oracle recommend/canary recommend/g;
   s/oracle version/canary version/g;
   s/oracle init/canary init/g;
   s/oracle migrate/canary migrate/g;
   s/oracle-test-author/canary-test-author/g;
   s/oracle-test-reviewer/canary-test-reviewer/g;
   s/oracle-test-generator/canary-test-generator/g;
   s/oracle-test-healer/canary-test-healer/g;
   s/oracle-flake-hunter/canary-flake-hunter/g;
   s/oracle-framework-advisor/canary-framework-advisor/g;
   s/oracle-initializer/canary-initializer/g;
   s/oracle-migrator/canary-migrator/g;
   s/oracle:generate/canary:generate/g;
   s/oracle:init/canary:init/g;
   s/oracle:migrate/canary:migrate/g;
   s/\/oracle-write-test/\/canary-write-test/g;
   s/\/oracle-pick-framework/\/canary-pick-framework/g;
   s/\/oracle-debug-flake/\/canary-debug-flake/g;
   s|\.oracle/|\.canary/|g;
   s/oracle@oracle/canary@canary/g;
   s/oracle-test-ai/canary-test-ai/g' \
  "${DOCS[@]}"

# Verify no functional oracle identifiers remain
grep -rn "oracle generate\|oracle version\|oracle recommend\|oracle init\b\|oracle migrate\|oracle@oracle\|oracle-test-ai\|oracle-test-author\|oracle-test-generator\|oracle-flake-hunter\|oracle-framework-advisor\|oracle-initializer\|oracle-migrator\|oracle:generate\|oracle:init\|oracle:migrate\|/oracle-write-test\|/oracle-pick-framework\|/oracle-debug-flake\|\.oracle/" \
  "${DOCS[@]}" && echo "REMAINING — fix manually" || echo "clean"

python -m unittest discover tests/unit -q
harness validate
harness check-deps
git add -A
git commit -m "chore(rename): docs bulk pass — CLI, agent, slash command refs"
```

Then push and open PR.

## Uncertainties

- `[ASSUMPTION]` `sed -i ''` multi-statement form works on macOS zsh — tested
  pattern; if a statement fails silently, verify with grep after each task.
- `[ASSUMPTION]` `test_mcp_server.py` comment-only refs (`# oracle__`) don't
  affect test outcomes — confirmed by reading the file; comments only.
- `[DEFERRABLE]` Product display name "Oracle" in ADR prose and completed
  plan docs — leave as historical record; update only current user-facing docs
  (README, AGENTS.md, wiki).
