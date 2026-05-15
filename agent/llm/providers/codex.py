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
