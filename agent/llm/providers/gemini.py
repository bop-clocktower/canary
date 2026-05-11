# agent/llm/providers/gemini.py

"""Google Gemini provider for Oracle.

Implements the BaseProvider interface using the google-generativeai
SDK. Lazy-imports the SDK so the rest of the system stays usable
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

        import google.generativeai as genai

        genai.configure(api_key=api_key)
        self._genai = genai
        self.model_name = model

    def generate(self, messages: List[Dict[str, str]]) -> str:
        # Gemini takes the system prompt as a model-construction kwarg
        # and user turns as `contents`.
        system_parts = [
            m["content"] for m in messages if m.get("role") == "system"
        ]
        user_parts = [
            m["content"] for m in messages if m.get("role") == "user"
        ]

        model = self._genai.GenerativeModel(
            self.model_name,
            system_instruction=(
                "\n\n".join(system_parts) if system_parts else None
            ),
        )
        response = model.generate_content("\n\n".join(user_parts))

        text = getattr(response, "text", None)
        if not text:
            raise RuntimeError(
                f"Gemini API returned no text. Model: {self.model_name}"
            )
        return text
