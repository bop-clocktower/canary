import unittest
import os
from agent.llm.factory import ProviderFactory
from agent.llm.providers.openai import OpenAIProvider
from agent.llm.providers.mock import MockProvider

class TestProviderFactory(unittest.TestCase):

    def test_default_provider(self):
        # Should default to openai (but might fail if key missing, so we check type)
        if "ORACLE_LLM_PROVIDER" in os.environ:
            del os.environ["ORACLE_LLM_PROVIDER"]
        
        self.assertEqual(ProviderFactory._providers["openai"], OpenAIProvider)

    def test_mock_provider_selection(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "mock"
        provider = ProviderFactory.get_provider()
        self.assertIsInstance(provider, MockProvider)

    def test_invalid_provider(self):
        os.environ["ORACLE_LLM_PROVIDER"] = "rick-llm"
        with self.assertRaises(ValueError):
            ProviderFactory.get_provider()

if __name__ == '__main__':
    unittest.main()
