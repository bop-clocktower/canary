# LLM Providers Guide

Oracle abstracts the LLM behind a provider interface so the pipeline can swap backends without touching orchestration code. Providers are resolved at call time from an environment variable; only the active provider and the mock are ever imported in a process, so missing optional SDKs (e.g., a project that doesn't have `google-generativeai` installed) don't break the others.

## Core Concepts

### 1. The Provider Contract

Every provider implements `agent/llm/providers/base.py:BaseProvider`. The minimum surface: a `generate(messages: list[dict]) -> str` method that accepts OpenAI-style chat messages (`role` + `content`) and returns the completion text. Provider-specific configuration (API key, model name, temperature) lives inside the provider; callers see only the abstract method.

### 2. Provider Registry

`agent/llm/factory.py` maintains a small in-process map of provider names → `(module_path, class_name)`:

```python
_PROVIDER_REGISTRY = {
    "anthropic": ("agent.llm.providers.anthropic", "AnthropicProvider"),
    "gemini":    ("agent.llm.providers.gemini", "GeminiProvider"),
    "openai":    ("agent.llm.providers.openai", "OpenAIProvider"),
    "mock":      ("agent.llm.providers.mock", "MockProvider"),
}
```

`ProviderFactory.get_provider()` reads `ORACLE_LLM_PROVIDER`, looks up the entry, lazy-imports the module, and instantiates the class. An unknown name raises `ValueError` listing the available providers — never falls back silently.

### 3. Default Provider

`DEFAULT_PROVIDER = "anthropic"`. Anthropic Claude is the default; Gemini and OpenAI are first-class alternatives. The mock provider is for tests only and produces deterministic stub responses.

### 4. Singleton Client

`agent/llm/__init__.py` exposes `get_llm()` — a thread-safe singleton `LLMClient` wrapping the resolved provider. Callers use `generate_response(prompt)` which prepends the Oracle system prompt (`"You are Oracle, a senior test automation engineer."`) and dispatches to the singleton.

The singleton is initialized once per process. Changing `ORACLE_LLM_PROVIDER` mid-process does **not** flip the active provider — restart the process to switch.

## Switching Providers

### 1. Set the Env Var

```bash
export ORACLE_LLM_PROVIDER=gemini
export GOOGLE_API_KEY=...   # provider-specific cred
```

Available values: `anthropic`, `gemini`, `openai`, `mock`. Case-insensitive (`Anthropic` works).

### 2. Confirm Credentials

Each provider reads its own credentials from the environment:

- `anthropic` → `ANTHROPIC_API_KEY`
- `gemini` → `GOOGLE_API_KEY` (or whichever env the provider implementation reads — check `agent/llm/providers/gemini.py`)
- `openai` → `OPENAI_API_KEY`
- `mock` → none

Missing credentials surface as the provider SDK's authentication error, not as a generic Oracle error.

### 3. Verify in a Dry Run

```bash
ORACLE_LLM_PROVIDER=gemini python -m agent.cli generate "Test that GET /health returns 200"
```

Check that the generated file looks idiomatic for the chosen provider and that the resolved framework matches expectation. Different providers can produce different code style; only the framework choice should be deterministic across providers (it comes from the registry, not the LLM).

### 4. Switch in Tests

For unit tests, pin to `mock`:

```bash
ORACLE_LLM_PROVIDER=mock pytest tests/
```

The mock provider produces deterministic output, never makes a network call, and never reads real credentials.

## Provider Capability Notes

- **Anthropic (default).** Best general code-generation quality at time of writing. Long context window is useful when generating tests against a large API spec passed in the prompt.
- **Gemini.** Strong on structured output; good fit when the prompt template is highly schematized. Some tool-use behaviors differ — review the provider implementation in `agent/llm/providers/gemini.py` before assuming feature parity.
- **OpenAI.** Reliable baseline. Use when comparing across providers for the same prompt to identify which model agrees with the SUT's expected behavior.
- **Mock.** Test-only. Returns stub strings; useful for asserting orchestrator behavior without paying for inference.

## Adding a New Provider

1. Add a class extending `BaseProvider` under `agent/llm/providers/<name>.py`. Implement `generate(messages)`.
2. Register it in `_PROVIDER_REGISTRY` in `agent/llm/factory.py`: `"<name>": ("agent.llm.providers.<name>", "<NameProvider>")`.
3. Document the env var the provider reads for credentials.
4. Add a test under `tests/unit/test_factory.py` confirming `ProviderFactory.get_provider()` returns an instance when `ORACLE_LLM_PROVIDER=<name>`.
5. Update this guide's provider-capability section.

No changes needed in the orchestrator, classifier, or recommender — the contract is fully behind the factory.

## Failure Modes

- **Unknown provider name.** `ValueError` from `get_provider`. Fix the env var.
- **Missing optional SDK.** Surfaces as `ImportError` only when that provider is selected. Other providers continue to work.
- **Provider-side rate limit or 5xx.** Surfaces as the SDK's exception. Oracle does not retry — wrap your caller if you want retry semantics, or wait for the planned self-healing loop.
- **Wrong credentials.** Surfaces as the SDK's auth error. Oracle does not mask this.

## Related

- [Orchestrator Guide](./orchestrator.md) — how the LLM call sits in the pipeline
- [Self-Healing and Feedback Loop](../wiki/Self-Healing-and-Feedback-Loop.md) — planned retry/repair logic above the provider layer
