# Guides

Practical, focused guides to Canary's components and contracts. Each guide
explains _what_ a piece does, _how_ it plugs into the pipeline, and _how to
drive it_ from the CLI or programmatically. For agent-invokable workflows
(generate a test, promote a test, add a framework), see
[Agent Skills](../../agents/skills/README.md).

## Available Guides

### [Orchestrator Guide](./orchestrator.md)

The central execution engine. Walks the three-stage pipeline (classify →
recommend → generate), the registry-driven framework selection, pluggable LLM
providers, and the generated-test conventions.

**Best for:** Understanding how a natural-language prompt becomes a test file.

### [Framework Registry Guide](./framework-registry.md)

The single source of truth for which testing frameworks Canary supports. Covers
the entry schema, the classifier↔registry contract, the lookup surface
(`get_by_category`, `get_preferred_by_category`, `find_by_name`,
`match_by_language`), and how categories form the public contract between
classifier and recommender.

**Best for:** Adding, deprecating, or auditing framework support.

### [Company Knowledge Guide](./company-knowledge.md)

Configuration system for grounding AI generation in internal context —
Confluence spaces, Jira projects, internal doc URLs, MCP servers, and Claude
Code skill slugs. Covers the three-source merge cascade (org defaults →
project-local → env override), interactive scaffolding, MCP validation, and the
`--- COMPANY KNOWLEDGE ---` prompt injection format.

**Best for:** Setting up or debugging `.canary/company.json` in a project.

### [Tracked Overlays Guide](./tracked-overlays.md)

The `canary overlay add/update/list/remove` command group for tracking a
downstream skills overlay as a git clone under `~/.canary/overlays/`. Covers the
source grammar, the skill-discovery precedence tier
(`bundled < overlay < global < local`), freshness/update semantics, and the
`overlays.json` registry.

**Best for:** Installing and keeping a downstream overlay current without
hand-copying skill directories.

### [Harness + Canary Integration Guide](./harness-canary-integration.md)

The routing and ownership contract for running the canary plugin and the harness
toolkit together. Covers skill double-registration (`/canary-X` vs
`harness:canary-X`) and which to prefer, a canary-vs-harness skill
disambiguation matrix, the config-ownership map (`harness.config.json` vs
`.canary/` vs `pyproject.toml`/`package.json`), the `roadmap.md` ↔
`CANARY_STATE.md` ledger roles, and the "what is the merge gate" answer.

**Best for:** Deciding which tool owns a setting or which skill to invoke when
both are installed.

### [LLM Providers Guide](./llm-providers.md)

**Removed in v3.0.** The `agent/llm/` provider layer was deleted — there are no
providers to configure and no API key to set. LLM work runs through your Claude
Code session via the plugin. The guide is kept as a removal note pointing to the
current model.

## Related

- [Agent Skills](../../agents/skills/README.md) — agent-invokable workflows in
  the SKILL.md format
- [Architecture Deep-Dive](../wiki/Architecture-Deep-Dive.md) — module-by-module
  internals
- [Harness Engineering Integration](../wiki/Harness-Engineering-Integration.md)
  — how Canary plugs into the harness toolkit
- [Roadmap](../roadmap.md) — what's planned and what's in flight
