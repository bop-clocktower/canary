# agent/llm/providers/openai.py

"""
OpenAI Provider - Integration with OpenAI's Chat Completion API.

This module implements the BaseProvider interface for OpenAI, enabling
the agent to generate test code using GPT-series models.
"""

import os
from typing import List, Dict
from openai import OpenAI
from agent.llm.providers.base import BaseProvider

class OpenAIProvider(BaseProvider):
    """
    OpenAI-specific LLM provider implementation.
    """

    def __init__(self, model: str = "gpt-4o-mini"):
        """
        Initializes the provider with the specified model and API key.

        Args:
            model: The OpenAI model name to use. Defaults to 'gpt-4o-mini'.
        """
        api_key = os.getenv("OPENAI_API_KEY")
        
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY not found. "
                "Set the OPENAI_API_KEY environment variable to use Oracle's "
                "generation features with OpenAI."
            )

        self.client = OpenAI(api_key=api_key)
        self.model = model

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Generates a completion using OpenAI's chat interface.

        Args:
            messages: A list of message dictionaries for the chat context.

        Returns:
            The generated content as a string.
        """
        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages
        )

        if not response.choices or len(response.choices) == 0:
            raise RuntimeError(f"OpenAI API returned an empty response choices list. Model: {self.model}")
        
        message = response.choices[0].message
        if not message or message.content is None:
            raise RuntimeError(f"OpenAI API returned a malformed message. Model: {self.model}")

        return message.content
