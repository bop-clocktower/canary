# LLM Providers Guide

> **Removed in v3.0.** This guide described the `agent/llm/` provider layer
> (`ProviderFactory`, `BaseProvider`, the `anthropic`/`gemini`/`openai`/`mock`
> backends, and the `CANARY_LLM_PROVIDER` env var), which has been deleted.

There are no LLM providers to configure and no API key to set. LLM work runs
through your Claude Code session via the plugin; the CLI is deterministic.

See [LLM Providers & Configuration](../wiki/LLM-Providers-and-Configuration.md)
for the migration summary and [Architecture Deep Dive](../wiki/Architecture-Deep-Dive.md)
for the current model.
