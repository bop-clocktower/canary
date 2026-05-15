# agent/llm/providers/gemini.py

"""Google Gemini provider for Oracle.

Implements the BaseProvider interface using the google-genai SDK.
Lazy-imports the SDK so the rest of the system stays usable
without the optional package installed.
"""

import os
from typing import List, Dict

from agent.llm.providers.base import BaseProvider


class GeminiProvider(BaseProvider):
    """Gemini-backed LLM provider."""

    DEFAULT_MODEL = "gemini-1.5-flash"

    def __init__(self, model: str = DEFAULT_MODEL):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY not found. "
                "Set the GEMINI_API_KEY environment variable to use "
                "Oracle's generation features with Gemini."
            )

        from google import genai

        self._client = genai.Client(api_key=api_key)
        self.model_name = model

    def generate(self, messages: List[Dict[str, str]]) -> str:
        from google.genai import types

        system_parts = [
            m["content"] for m in messages if m.get("role") == "system"
        ]
        user_parts = [
            m["content"] for m in messages if m.get("role") == "user"
        ]

        config = types.GenerateContentConfig(
            system_instruction=(
                "\n\n".join(system_parts) if system_parts else None
            ),
        )
        response = self._client.models.generate_content(
            model=self.model_name,
            contents="\n\n".join(user_parts),
            config=config,
        )

        text = getattr(response, "text", None)
        if not text:
            raise RuntimeError(
                f"Gemini API returned no text. Model: {self.model_name}"
            )
        return text
