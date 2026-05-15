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
        self.assertEqual(kwargs["system"], "You are a test generator.")
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


class TestGeminiProviderGenerate(unittest.TestCase):

    def setUp(self):
        os.environ["GEMINI_API_KEY"] = "test-key"

    def tearDown(self):
        os.environ.pop("GEMINI_API_KEY", None)

    @patch("google.genai.Client")
    def test_generate_returns_text(self, MockClient):
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance
        resp = MagicMock()
        resp.text = "gemini output"
        mock_instance.models.generate_content.return_value = resp

        from agent.llm.providers.gemini import GeminiProvider
        result = GeminiProvider().generate(
            [{"role": "user", "content": "write a test"}]
        )
        self.assertEqual(result, "gemini output")

    @patch("google.genai.Client")
    def test_generate_passes_system_instruction(self, MockClient):
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance
        resp = MagicMock()
        resp.text = "ok"
        mock_instance.models.generate_content.return_value = resp

        messages = [
            {"role": "system", "content": "You are a test generator."},
            {"role": "user", "content": "write a test"},
        ]
        from agent.llm.providers.gemini import GeminiProvider
        GeminiProvider().generate(messages)

        call_kwargs = mock_instance.models.generate_content.call_args[1]
        self.assertEqual(
            call_kwargs["config"].system_instruction,
            "You are a test generator.",
        )

    @patch("google.genai.Client")
    def test_generate_raises_on_empty_text(self, MockClient):
        mock_instance = MagicMock()
        MockClient.return_value = mock_instance
        resp = MagicMock()
        resp.text = None
        mock_instance.models.generate_content.return_value = resp

        from agent.llm.providers.gemini import GeminiProvider
        with self.assertRaises(RuntimeError):
            GeminiProvider().generate(
                [{"role": "user", "content": "x"}]
            )


def _mock_openai_client(MockOpenAI: MagicMock, text: str) -> MagicMock:
    """Wire MockOpenAI to return `text` from chat completions."""
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
