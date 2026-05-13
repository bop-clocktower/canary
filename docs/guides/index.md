# Guides

Practical, focused guides to Oracle's components and contracts. Each guide explains *what* a piece does, *how* it plugs into the pipeline, and *how to drive it* from the CLI or programmatically. For agent-invokable workflows (generate a test, promote a test, add a framework), see [Agent Skills](../../agents/skills/README.md).

## Available Guides

### [Orchestrator Guide](./orchestrator.md)

The central execution engine. Walks the three-stage pipeline (classify → recommend → generate), the registry-driven framework selection, pluggable LLM providers, and the generated-test conventions.

**Best for:** Understanding how a natural-language prompt becomes a test file.

### [Framework Registry Guide](./framework-registry.md)

The single source of truth for which testing frameworks Oracle supports. Covers the entry schema, the classifier↔registry contract, the lookup surface (`get_by_category`, `get_preferred_by_category`, `find_by_name`, `match_by_language`), and how categories form the public contract between classifier and recommender.

**Best for:** Adding, deprecating, or auditing framework support.

### [LLM Providers Guide](./llm-providers.md)

The provider abstraction behind every generation call. Covers the `BaseProvider` contract, the in-process provider registry, the `ORACLE_LLM_PROVIDER` env var, the thread-safe singleton client, and per-provider capability notes (Anthropic default, Gemini, OpenAI, mock).

**Best for:** Switching providers, running tests without paying for inference, or adding a new provider.

## Related

- [Agent Skills](../../agents/skills/README.md) — agent-invokable workflows in the SKILL.md format
- [Architecture Deep-Dive](../wiki/Architecture-Deep-Dive.md) — module-by-module internals
- [Harness Engineering Integration](../wiki/Harness-Engineering-Integration.md) — how Oracle plugs into the harness toolkit
- [Roadmap](../roadmap.md) — what's planned and what's in flight
