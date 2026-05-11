# agent/llm/factory.py

"""Provider factory for Oracle's LLM backends.

Resolves the active provider via the ORACLE_LLM_PROVIDER environment
variable. Provider classes are imported lazily so that missing optional
SDKs (e.g. `anthropic`, `google-generativeai`) do not break other
backends. Mock and the active provider are the only modules ever
imported in a given process.
"""

import importlib
import os
from typing import Dict, Tuple

from agent.llm.providers.base import BaseProvider


_PROVIDER_REGISTRY: Dict[str, Tuple[str, str]] = {
    # name -> (module_path, class_name)
    "anthropic": ("agent.llm.providers.anthropic", "AnthropicProvider"),
    "gemini": ("agent.llm.providers.gemini", "GeminiProvider"),
    "openai": ("agent.llm.providers.openai", "OpenAIProvider"),
    "mock": ("agent.llm.providers.mock", "MockProvider"),
}

DEFAULT_PROVIDER = "anthropic"


class ProviderFactory:
    """Resolves provider instances from ORACLE_LLM_PROVIDER."""

    @classmethod
    def get_provider(cls) -> BaseProvider:
        """Return a provider instance for the configured backend.

        Raises:
            ValueError: If ORACLE_LLM_PROVIDER names a backend not in
                the registry.
        """
        provider_name = os.getenv(
            "ORACLE_LLM_PROVIDER", DEFAULT_PROVIDER
        ).lower()
        entry = _PROVIDER_REGISTRY.get(provider_name)
        if entry is None:
            available = ", ".join(sorted(_PROVIDER_REGISTRY.keys()))
            raise ValueError(
                f"Unsupported LLM provider: '{provider_name}'. "
                f"Available providers: {available}. "
                "Set ORACLE_LLM_PROVIDER to switch."
            )

        module_path, class_name = entry
        module = importlib.import_module(module_path)
        provider_class = getattr(module, class_name)
        return provider_class()

    @classmethod
    def available_providers(cls) -> Tuple[str, ...]:
        """List provider names registered with the factory."""
        return tuple(sorted(_PROVIDER_REGISTRY.keys()))
