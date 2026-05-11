# agent/llm/factory.py

"""
Provider Factory - Orchestrates the instantiation of LLM providers.

This module provides a centralized way to switch between different LLM
backends (e.g., OpenAI, Mock) using environment variables.
"""

import os
from typing import Dict, Type
from agent.llm.providers.base import BaseProvider
from agent.llm.providers.openai import OpenAIProvider
from agent.llm.providers.mock import MockProvider

class ProviderFactory:
    """
    Factory for creating and managing LLM provider instances.
    """

    _providers: Dict[str, Type[BaseProvider]] = {
        "openai": OpenAIProvider,
        "mock": MockProvider
    }

    @classmethod
    def get_provider(cls) -> BaseProvider:
        """
        Returns a provider instance based on the ORACLE_LLM_PROVIDER setting.

        The provider is selected via the ORACLE_LLM_PROVIDER environment
        variable, defaulting to 'openai'.

        Returns:
            BaseProvider: An instance of the selected LLM provider.

        Raises:
            ValueError: If the requested provider is not in the registry.
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
