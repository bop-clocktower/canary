"""Unit tests for the provider factory."""

import os
import unittest

from agent.llm.factory import (
    DEFAULT_PROVIDER,
    ProviderFactory,
    _PROVIDER_REGISTRY,
)
from agent.llm.providers.mock import MockProvider


class TestProviderFactory(unittest.TestCase):

    def setUp(self):
        os.environ.pop("ORACLE_LLM_PROVIDER", None)

    def tearDown(self):
        os.environ.pop("ORACLE_LLM_PROVIDER", None)

    def test_default_is_anthropic(self):
        self.assertEqual(DEFAULT_PROVIDER, "anthropic")
        self.assertIn("anthropic", _PROVIDER_REGISTRY)

    def test_registry_lists_target_providers(self):
        # Lock in the provider matrix we promise users.
        self.assertEqual(
            set(ProviderFactory.available_providers()),
            {"anthropic", "gemini", "openai", "mock"},
        )

    def test_mock_provider_selection(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "mock"
        provider = ProviderFactory.get_provider()
        self.assertIsInstance(provider, MockProvider)

    def test_invalid_provider_raises(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "rick-llm"
        with self.assertRaises(ValueError):
            ProviderFactory.get_provider()

    def test_anthropic_provider_requires_key(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "anthropic"
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with self.assertRaises(RuntimeError):
            ProviderFactory.get_provider()

    def test_gemini_provider_requires_key(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "gemini"
        os.environ.pop("GEMINI_API_KEY", None)
        with self.assertRaises(RuntimeError):
            ProviderFactory.get_provider()


if __name__ == "__main__":
    unittest.main()
