# agent/llm/providers/openai.py

import os
from typing import List, Dict, Any
from openai import OpenAI
from rich import print
from agent.llm.providers.base import BaseProvider

class OpenAIProvider(BaseProvider):
    """
    OpenAI-specific LLM provider.
    """

    def __init__(self, model: str = "gpt-4o-mini"):
        api_key = os.getenv("OPENAI_API_KEY")
        
        if not api_key:
            error_msg = (
                "\n[bold red]❌ Error: OPENAI_API_KEY not found.[/bold red]\n"
                "[yellow]To use Oracle's generation features with OpenAI, please set your API key:[/yellow]\n"
                "export OPENAI_API_KEY='your-key-here'\n"
            )
            raise RuntimeError(error_msg)

        self.client = OpenAI(api_key=api_key)
        self.model = model

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Generate a completion using OpenAI's chat interface.
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
