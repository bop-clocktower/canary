# Plan: Multi-Provider LLM Support

**Date:** 2026-05-14 | **Spec:** docs/roadmap.md (Provider Platform)
**Tasks:** 5 | **Time:** ~22 min | **Integration Tier:** medium

## Goal

Oracle's LLM layer supports five providers — Claude (default), Gemini,
OpenAI, Codex, and Mock — via `ORACLE_LLM_PROVIDER`, each fully tested
with unit tests that mock the underlying SDK.

## Observable Truths (Acceptance Criteria)

1. `ProviderFactory.available_providers()` returns
   `("anthropic", "codex", "gemini", "mock", "openai")`.
2. `ORACLE_LLM_PROVIDER=codex` with `OPENAI_API_KEY` unset raises
   `RuntimeError` on `ProviderFactory.get_provider()`.
3. `ORACLE_LLM_PROVIDER=openai` with `OPENAI_API_KEY` unset raises
   `RuntimeError` on `ProviderFactory.get_provider()`.
4. `pytest tests/unit/` passes, including new `test_providers.py` with
   generate() tests for Anthropic, Gemini, OpenAI, and Codex (mocked
   SDKs).
5. `harness validate` passes after all changes.
6. `ProviderFactory.get_provider()` with `ORACLE_LLM_PROVIDER` unset
   returns an `AnthropicProvider` instance (default switched from OpenAI
   to Claude, covered by `test_default_is_anthropic`).

## Uncertainties

- [ASSUMPTION] Codex provider is a distinct class (not an alias)
  wrapping OpenAI's API with `gpt-4o` as the default model and
  `OPENAI_API_KEY` for auth. Rationale: keeps Codex model selection
  independent from the generic OpenAI provider. If incorrect, Task 1
  and Task 2 need redesign.
- [DEFERRABLE] No Python 3.10+ interpreter found in the current shell
  environment. Test commands use `pytest` and assume the correct venv is
  active. Set up a 3.10+ venv before running execution.

## Changes

- [ADDED] `agent/llm/providers/codex.py` — CodexProvider class
- [MODIFIED] `agent/llm/factory.py` — add `"codex"` to
  `_PROVIDER_REGISTRY`
- [MODIFIED] `tests/unit/test_factory.py` — add codex to registry
  assertion; add openai and codex key-missing tests
- [ADDED] `tests/unit/test_providers.py` — generate() tests for all
  four concrete providers

## File Map

```text
CREATE agent/llm/providers/codex.py
MODIFY agent/llm/factory.py
MODIFY tests/unit/test_factory.py
CREATE tests/unit/test_providers.py
```

---

## Tasks

### Task 1: Implement CodexProvider (TDD)

**Depends on:** none
**Files:** `agent/llm/providers/codex.py`,
`tests/unit/test_providers.py`

1. Create `tests/unit/test_providers.py` with the init tests for
   CodexProvider only:

   ```python
   """Unit tests for concrete LLM provider generate() methods."""

   import os
   import unittest
   from unittest.mock import MagicMock, patch


   class TestCodexProviderInit(unittest.TestCase):

       def tearDown(self):
           os.environ.pop("OPENAI_API_KEY", None)

       def test_requires_api_key(self):
           os.environ.pop("OPENAI_API_KEY", None)
           from agent.llm.providers.codex import CodexProvider
           with self.assertRaises(RuntimeError):
               CodexProvider()

       def test_default_model_is_gpt4o(self):
           os.environ["OPENAI_API_KEY"] = "test-key"
           with patch("openai.OpenAI"):
               from agent.llm.providers.codex import CodexProvider
               provider = CodexProvider()
               self.assertEqual(provider.model, "gpt-4o")

       def test_custom_model_accepted(self):
           os.environ["OPENAI_API_KEY"] = "test-key"
           with patch("openai.OpenAI"):
               from agent.llm.providers.codex import CodexProvider
               provider = CodexProvider(model="gpt-4o-mini")
               self.assertEqual(provider.model, "gpt-4o-mini")
   ```

2. Run: `pytest tests/unit/test_providers.py -v`
   Observe: `ImportError` or 3 failures (module does not exist yet).

3. Create `agent/llm/providers/codex.py`:

   ```python
   # agent/llm/providers/codex.py

   """Code-optimised OpenAI provider for Codex environments.

   Uses OpenAI's chat completions API with gpt-4o as the default model
   (higher capability than the generic OpenAI provider's gpt-4o-mini).
   Reuses OPENAI_API_KEY. Implemented as a distinct class so model
   selection and future Codex-specific tuning remain independent from
   the generic OpenAI provider.
   """

   import os
   from typing import List, Dict

   from agent.llm.providers.base import BaseProvider


   class CodexProvider(BaseProvider):
       """Code-optimised OpenAI-backed provider for Codex environments."""

       DEFAULT_MODEL = "gpt-4o"

       def __init__(self, model: str = DEFAULT_MODEL):
           api_key = os.getenv("OPENAI_API_KEY")
           if not api_key:
               raise RuntimeError(
                   "OPENAI_API_KEY not found. "
                   "Set the OPENAI_API_KEY environment variable to use "
                   "Oracle's generation features with the Codex provider."
               )

           from openai import OpenAI

           self.client = OpenAI(api_key=api_key)
           self.model = model

       def generate(self, messages: List[Dict[str, str]]) -> str:
           response = self.client.chat.completions.create(
               model=self.model,
               messages=messages,
           )

           if not response.choices:
               raise RuntimeError(
                   "Codex API returned empty choices. "
                   f"Model: {self.model}"
               )

           message = response.choices[0].message
           if not message or message.content is None:
               raise RuntimeError(
                   "Codex API returned malformed message. "
                   f"Model: {self.model}"
               )

           return message.content
   ```

4. Run: `pytest tests/unit/test_providers.py -v`
   Observe: 3 tests pass.

5. Run: `harness validate`

6. Commit:
   `feat(llm): add CodexProvider with gpt-4o default`

---

### Task 2: Register CodexProvider and complete factory tests (TDD)

**Depends on:** Task 1
**Files:** `agent/llm/factory.py`, `tests/unit/test_factory.py`

1. Add failing tests to `tests/unit/test_factory.py`:

   ```python
   def test_registry_lists_target_providers(self):
       # Updated: now includes codex
       self.assertEqual(
           set(ProviderFactory.available_providers()),
           {"anthropic", "codex", "gemini", "mock", "openai"},
       )

   def test_codex_provider_requires_key(self):
       os.environ["ORACLE_LLM_PROVIDER"] = "codex"
       os.environ.pop("OPENAI_API_KEY", None)
       with self.assertRaises(RuntimeError):
           ProviderFactory.get_provider()

   def test_openai_provider_requires_key(self):
       os.environ["ORACLE_LLM_PROVIDER"] = "openai"
       os.environ.pop("OPENAI_API_KEY", None)
       with self.assertRaises(RuntimeError):
           ProviderFactory.get_provider()
   ```

   Note: `test_registry_lists_target_providers` already exists —
   replace the assertion set to include `"codex"`.

2. Run: `pytest tests/unit/test_factory.py -v`
   Observe: `test_registry_lists_target_providers` fails
   (codex absent), `test_codex_provider_requires_key` fails.

3. In `agent/llm/factory.py`, add to `_PROVIDER_REGISTRY`:

   ```python
   "codex": ("agent.llm.providers.codex", "CodexProvider"),
   ```

4. Run: `pytest tests/unit/test_factory.py -v`
   Observe: all tests pass.

5. Run: `harness validate`

6. Commit:
   `feat(llm): register CodexProvider; add openai/codex key tests`

---

### Task 3: Add generate() tests for AnthropicProvider

**Depends on:** Task 1
**Files:** `tests/unit/test_providers.py`

Note: Implementation already exists — tests verify existing behaviour.
Write test → run → confirm pass → commit.

1. Append to `tests/unit/test_providers.py`:

   ```python
   class TestAnthropicProviderGenerate(unittest.TestCase):

       def setUp(self):
           os.environ["ANTHROPIC_API_KEY"] = "test-key"

       def tearDown(self):
           os.environ.pop("ANTHROPIC_API_KEY", None)

       def _mock_response(self, text: str):
           block = MagicMock()
           block.type = "text"
           block.text = text
           resp = MagicMock()
           resp.content = [block]
           return resp

       @patch("anthropic.Anthropic")
       def test_generate_returns_text(self, MockAnthropic):
           mock_client = MagicMock()
           MockAnthropic.return_value = mock_client
           mock_client.messages.create.return_value = (
               self._mock_response("generated code")
           )

           from agent.llm.providers.anthropic import AnthropicProvider
           result = AnthropicProvider().generate(
               [{"role": "user", "content": "write a test"}]
           )
           self.assertEqual(result, "generated code")

       @patch("anthropic.Anthropic")
       def test_generate_routes_system_to_kwarg(self, MockAnthropic):
           mock_client = MagicMock()
           MockAnthropic.return_value = mock_client
           mock_client.messages.create.return_value = (
               self._mock_response("ok")
           )

           messages = [
               {"role": "system", "content": "You are a test generator."},
               {"role": "user", "content": "write a test"},
           ]
           from agent.llm.providers.anthropic import AnthropicProvider
           AnthropicProvider().generate(messages)

           kwargs = mock_client.messages.create.call_args[1]
           self.assertEqual(
               kwargs["system"], "You are a test generator."
           )
           self.assertEqual(
               kwargs["messages"],
               [{"role": "user", "content": "write a test"}],
           )

       @patch("anthropic.Anthropic")
       def test_generate_raises_on_empty_content(self, MockAnthropic):
           mock_client = MagicMock()
           MockAnthropic.return_value = mock_client
           resp = MagicMock()
           resp.content = []
           mock_client.messages.create.return_value = resp

           from agent.llm.providers.anthropic import AnthropicProvider
           with self.assertRaises(RuntimeError):
               AnthropicProvider().generate(
                   [{"role": "user", "content": "x"}]
               )
   ```

2. Run: `pytest tests/unit/test_providers.py::TestAnthropicProviderGenerate -v`
   Observe: 3 tests pass.

3. Run: `harness validate`

4. Commit:
   `test(llm): add AnthropicProvider generate() tests`

---

### Task 4: Add generate() tests for GeminiProvider

**Depends on:** Task 3
**Files:** `tests/unit/test_providers.py`

Note: `@patch('google.generativeai.GenerativeModel')` patches the
attribute in-place on the module object. Because `GeminiProvider`
stores `self._genai = genai` (the module reference), subsequent calls
to `self._genai.GenerativeModel(...)` resolve through the same object
and pick up the patch.

1. Append to `tests/unit/test_providers.py`:

   ```python
   class TestGeminiProviderGenerate(unittest.TestCase):

       def setUp(self):
           os.environ["GEMINI_API_KEY"] = "test-key"

       def tearDown(self):
           os.environ.pop("GEMINI_API_KEY", None)

       @patch("google.generativeai.GenerativeModel")
       @patch("google.generativeai.configure")
       def test_generate_returns_text(self, mock_configure, MockModel):
           mock_instance = MagicMock()
           MockModel.return_value = mock_instance
           resp = MagicMock()
           resp.text = "gemini output"
           mock_instance.generate_content.return_value = resp

           from agent.llm.providers.gemini import GeminiProvider
           result = GeminiProvider().generate(
               [{"role": "user", "content": "write a test"}]
           )
           self.assertEqual(result, "gemini output")

       @patch("google.generativeai.GenerativeModel")
       @patch("google.generativeai.configure")
       def test_generate_passes_system_instruction(
           self, mock_configure, MockModel
       ):
           mock_instance = MagicMock()
           MockModel.return_value = mock_instance
           resp = MagicMock()
           resp.text = "ok"
           mock_instance.generate_content.return_value = resp

           messages = [
               {"role": "system", "content": "You are a test generator."},
               {"role": "user", "content": "write a test"},
           ]
           from agent.llm.providers.gemini import GeminiProvider
           GeminiProvider().generate(messages)

           call_kwargs = MockModel.call_args[1]
           self.assertEqual(
               call_kwargs["system_instruction"],
               "You are a test generator.",
           )

       @patch("google.generativeai.GenerativeModel")
       @patch("google.generativeai.configure")
       def test_generate_raises_on_empty_text(
           self, mock_configure, MockModel
       ):
           mock_instance = MagicMock()
           MockModel.return_value = mock_instance
           resp = MagicMock()
           resp.text = None
           mock_instance.generate_content.return_value = resp

           from agent.llm.providers.gemini import GeminiProvider
           with self.assertRaises(RuntimeError):
               GeminiProvider().generate(
                   [{"role": "user", "content": "x"}]
               )
   ```

2. Run: `pytest tests/unit/test_providers.py::TestGeminiProviderGenerate -v`
   Observe: 3 tests pass.

3. Run: `harness validate`

4. Commit:
   `test(llm): add GeminiProvider generate() tests`

---

### Task 5: Add generate() tests for OpenAIProvider and CodexProvider

**Depends on:** Task 2, Task 4
**Files:** `tests/unit/test_providers.py`

Note: OpenAIProvider uses a module-level import (`from openai import
OpenAI`), so patch at `agent.llm.providers.openai.OpenAI`. CodexProvider
lazy-imports inside `__init__`, so patch at `openai.OpenAI`.

1. Append to `tests/unit/test_providers.py`:

   ```python
   def _mock_openai_client(MockOpenAI: MagicMock, text: str) -> MagicMock:
       """Helper: wire MockOpenAI to return `text` from chat completions."""
       mock_client = MagicMock()
       MockOpenAI.return_value = mock_client
       choice = MagicMock()
       choice.message.content = text
       resp = MagicMock()
       resp.choices = [choice]
       mock_client.chat.completions.create.return_value = resp
       return mock_client


   class TestOpenAIProviderGenerate(unittest.TestCase):

       def setUp(self):
           os.environ["OPENAI_API_KEY"] = "test-key"

       def tearDown(self):
           os.environ.pop("OPENAI_API_KEY", None)

       @patch("agent.llm.providers.openai.OpenAI")
       def test_generate_returns_content(self, MockOpenAI):
           _mock_openai_client(MockOpenAI, "openai output")
           from agent.llm.providers.openai import OpenAIProvider
           result = OpenAIProvider().generate(
               [{"role": "user", "content": "write a test"}]
           )
           self.assertEqual(result, "openai output")

       @patch("agent.llm.providers.openai.OpenAI")
       def test_generate_raises_on_empty_choices(self, MockOpenAI):
           mock_client = MagicMock()
           MockOpenAI.return_value = mock_client
           resp = MagicMock()
           resp.choices = []
           mock_client.chat.completions.create.return_value = resp

           from agent.llm.providers.openai import OpenAIProvider
           with self.assertRaises(RuntimeError):
               OpenAIProvider().generate(
                   [{"role": "user", "content": "x"}]
               )


   class TestCodexProviderGenerate(unittest.TestCase):

       def setUp(self):
           os.environ["OPENAI_API_KEY"] = "test-key"

       def tearDown(self):
           os.environ.pop("OPENAI_API_KEY", None)

       @patch("openai.OpenAI")
       def test_generate_returns_content(self, MockOpenAI):
           _mock_openai_client(MockOpenAI, "codex output")
           from agent.llm.providers.codex import CodexProvider
           result = CodexProvider().generate(
               [{"role": "user", "content": "write a test"}]
           )
           self.assertEqual(result, "codex output")

       @patch("openai.OpenAI")
       def test_generate_raises_on_empty_choices(self, MockOpenAI):
           mock_client = MagicMock()
           MockOpenAI.return_value = mock_client
           resp = MagicMock()
           resp.choices = []
           mock_client.chat.completions.create.return_value = resp

           from agent.llm.providers.codex import CodexProvider
           with self.assertRaises(RuntimeError):
               CodexProvider().generate(
                   [{"role": "user", "content": "x"}]
               )
   ```

2. Run: `pytest tests/unit/test_providers.py -v`
   Observe: all tests in file pass (12+ total).

3. Run: `pytest tests/unit/ -v`
   Observe: full unit suite passes.

4. Run: `harness validate`

5. Commit:
   `test(llm): add OpenAI and Codex generate() tests`

---

## Decisions

- **Codex as distinct class:** Implemented as `CodexProvider` (not an
  alias) with `DEFAULT_MODEL = "gpt-4o"`. Keeps Codex model selection
  independent from `OpenAIProvider` (`gpt-4o-mini`). Revisit if the
  two providers converge.
- **No pyproject.toml changes:** `openai` SDK already declared as a
  required dependency and covers both the OpenAI and Codex providers.
