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
