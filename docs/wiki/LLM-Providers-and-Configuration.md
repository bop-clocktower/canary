# LLM Providers & Configuration 🤖

Oracle is designed to be **LLM-agnostic**. You can switch between different AI backends without changing the core test generation logic.

## The Factory Pattern
The `ProviderFactory` selects the appropriate backend based on the `ORACLE_LLM_PROVIDER` environment variable.

## Available Providers

| Provider | Description | Required Configuration |
| :--- | :--- | :--- |
| `openai` (Default) | Uses GPT-4o-mini for fast, reliable test generation. | `OPENAI_API_KEY` |
| `mock` | Returns static test templates. Perfect for testing, development, and CI environments. | None |
| `gemini` (Planned) | Integration with Google's Gemini models. | `GEMINI_API_KEY` |

## How to Configure

### Switching Providers
To switch to the Mock provider:
```bash
export ORACLE_LLM_PROVIDER='mock'
```

### Setting API Keys
Oracle uses **lazy initialization**, meaning it only checks for an API key at the exact moment of generation. This allows the CLI to run `version` or `recommend-only` commands even if no key is set.

```bash
export OPENAI_API_KEY='your-key-here'
```

## Creating a New Provider
To add a new LLM backend:
1. Create a new file in `agent/llm/providers/`.
2. Inherit from `BaseProvider`.
3. Register the new provider in `agent/llm/factory.py`.
