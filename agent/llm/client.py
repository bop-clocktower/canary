# agent/llm/client.py

from typing import List, Dict
from agent.llm.factory import ProviderFactory

class LLMClient:
    """
    Central LLM abstraction for Oracle.
    Now acts as a wrapper around the factory-selected provider.
    """

    def __init__(self):
        # The factory handles selection and provider-specific validation (like API keys)
        self.provider = ProviderFactory.get_provider()

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Delegate generation to the selected provider.
        """
        return self.provider.generate(messages)
