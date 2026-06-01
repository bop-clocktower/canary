# LLM Providers & Configuration

> **Removed in v3.0.** Canary no longer has a pluggable LLM-provider layer.

Earlier versions (the Oracle POC, ≤ 2.x) shipped a `ProviderFactory` with
`anthropic` / `gemini` / `openai` / `mock` backends selected via a
`CANARY_LLM_PROVIDER` (then `ORACLE_LLM_PROVIDER`) environment variable, each
needing its own API key.

That entire layer (`agent/llm/`) was deleted in v3.0. **There is no API key or
provider configuration to set.** All LLM work now runs through your Claude Code
session when you use the plugin:

- **Generation** happens in-session via the `canary-test-author` agent
  (`/canary-write-test`) — see [Getting Started](Getting-Started.md).
- **The CLI** (`canary recommend`, `init`, `run`, `migrate`) is deterministic
  and makes no LLM calls.

See [Architecture Deep Dive](Architecture-Deep-Dive.md) for the current model.
