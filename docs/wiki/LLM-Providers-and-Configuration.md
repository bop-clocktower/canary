# LLM Providers & Configuration 🤖

Oracle is designed to be **LLM-agnostic**. You can switch between
different AI backends without changing the core test generation logic.

## The Factory Pattern

The `ProviderFactory` selects the appropriate backend based on the
`ORACLE_LLM_PROVIDER` environment variable.

## Available Providers

| Provider | Description | Required Configuration |
| :--- | :--- | :--- |
| `anthropic` (Default) | Uses Claude Sonnet for high-quality test generation. | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini Flash for fast, low-cost generation. | `GEMINI_API_KEY` |
| `openai` | Uses GPT-4o-mini, retained as an alternative. | `OPENAI_API_KEY` |
| `mock` | Returns static test templates. Used by tests and CI. | None |

## How to Configure

### Switching Providers

To switch to a non-default provider:

```bash
export ORACLE_LLM_PROVIDER='gemini'
```

The default is `anthropic` (Claude) — no env-var needed to use it.

### Setting API Keys

Oracle uses **lazy initialization**: it only loads the provider SDK and
checks for an API key when generation actually runs. The CLI can run
`version` or `--recommend-only` commands with no key set, and missing
optional SDKs (e.g. `google-generativeai`) only break the provider
that needs them, not the rest of the system.

```bash
export ANTHROPIC_API_KEY='your-key-here'
```

## Creating a New Provider

To add a new LLM backend:

1. Create a new file in `agent/llm/providers/`.
2. Inherit from `BaseProvider` and implement `generate(messages)`.
3. Register the new provider in `_PROVIDER_REGISTRY` in
   `agent/llm/factory.py` as `(module_path, class_name)`.
