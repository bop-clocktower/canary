# agent/llm/providers/base.py

from typing import List, Dict, Any
from abc import ABC, abstractmethod

class BaseProvider(ABC):
    """
    Abstract base class for all LLM providers.
    """

    @abstractmethod
    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Generate a completion for the given messages.
        """
        pass
