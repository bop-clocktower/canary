# Orchestrator Guide

> **Removed in v3.0.** The `OracleOrchestrator` execution engine and its
> generate/self-heal loop were deleted along with the `agent/llm/` layer.

Generation and self-healing now run through the Claude Code plugin agents
(`canary-test-author`, `canary-test-healer`) using your Claude Code session —
there is no in-process orchestrator and no API key to configure.

What remains in the CLI is deterministic and orchestrator-free: `canary
recommend` (classifier + recommender), `canary init` (scaffolder), `canary run`
(executor), and `canary migrate`.

See [Architecture Deep Dive](../wiki/Architecture-Deep-Dive.md) for the current
model.
