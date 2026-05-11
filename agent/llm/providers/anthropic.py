# agent/llm/providers/anthropic.py

"""Anthropic Claude provider for Oracle.

Implements the BaseProvider interface using Anthropic's Messages API.
Lazy-imports the SDK so the rest of the system stays usable without the
optional `anthropic` package installed.
"""

import os
from typing import List, Dict

from agent.llm.providers.base import BaseProvider


class AnthropicProvider(BaseProvider):
    """Claude-backed LLM provider."""

    DEFAULT_MODEL = "claude-sonnet-4-6"
    DEFAULT_MAX_TOKENS = 4096

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY not found. "
                "Set the ANTHROPIC_API_KEY environment variable to use "
                "Oracle's generation features with Claude."
            )

        from anthropic import Anthropic

        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.max_tokens = max_tokens

    def generate(self, messages: List[Dict[str, str]]) -> str:
        # Anthropic accepts a top-level `system` arg, not a system message.
        system_parts = [
            m["content"] for m in messages if m.get("role") == "system"
        ]
        chat = [m for m in messages if m.get("role") != "system"]

        response = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system="\n\n".join(system_parts) if system_parts else None,
            messages=chat,
        )

        if not response.content:
            raise RuntimeError(
                f"Anthropic API returned empty content. Model: {self.model}"
            )

        # content is a list of blocks; concatenate any text blocks.
        text_parts = [
            block.text for block in response.content
            if getattr(block, "type", None) == "text"
        ]
        if not text_parts:
            raise RuntimeError(
                f"Anthropic API returned no text blocks. Model: {self.model}"
            )
        return "".join(text_parts)
