# agent/llm/factory.py

import os
from typing import Dict, Type
from agent.llm.providers.base import BaseProvider
from agent.llm.providers.openai import OpenAIProvider
from agent.llm.providers.mock import MockProvider

class ProviderFactory:
    """
    Factory for creating LLM provider instances.
    """

    _providers: Dict[str, Type[BaseProvider]] = {
        "openai": OpenAIProvider,
        "mock": MockProvider
    }

    @classmethod
    def get_provider(cls) -> BaseProvider:
        """
        Returns a provider instance based on ORACLE_LLM_PROVIDER.
        Defaults to 'openai'.
        """
        provider_name = os.getenv("ORACLE_LLM_PROVIDER", "openai").lower()
        
        provider_class = cls._providers.get(provider_name)
        
        if not provider_class:
            available = ", ".join(cls._providers.keys())
            raise ValueError(
                f"Unsupported LLM provider: '{provider_name}'. "
                f"Available providers: {available}. "
                "Set ORACLE_LLM_PROVIDER to switch."
            )
            
        return provider_class()
