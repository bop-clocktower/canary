# agent/llm/client.py

import os
import sys
from typing import List, Dict, Any

from openai import OpenAI
from rich import print


class LLMClient:
    """
    Central LLM abstraction for Oracle.
    """

    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        
        if not api_key:
            error_msg = (
                "\n[bold red]❌ Error: OPENAI_API_KEY not found.[/bold red]\n"
                "[yellow]To use Oracle's generation features, please set your API key:[/yellow]\n"
                "export OPENAI_API_KEY='your-key-here'\n"
            )
            raise RuntimeError(error_msg)

        self.client = OpenAI(api_key=api_key)
        self.model = "gpt-4o-mini" # Using a more standard model name for now

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Generic chat completion interface
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