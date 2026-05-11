# agent/llm/providers/mock.py

"""
Mock Provider - A deterministic LLM backend for testing and development.

This provider returns static code templates instead of calling an external
API, making it ideal for CI environments and local iteration.
"""

from typing import List, Dict
from agent.llm.providers.base import BaseProvider

class MockProvider(BaseProvider):
    """
    Mock LLM provider implementation for non-AI testing.
    """

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Returns a static mock response based on the input messages.

        Args:
            messages: The chat history context.

        Returns:
            str: A deterministic Playwright test template.
        """
        user_msg = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "No user prompt found")
        
        return f"""
/* 
 * Oracle Mock Generation
 * Provider: Mock
 * Input: {user_msg[:50]}...
 */

import {{ test, expect }} from '@playwright/test';

test('mock generated test', async ({{ page }}) => {{
  await page.goto('https://example.com');
  // Oracle: This is a mock response because ORACLE_LLM_PROVIDER=mock
}});
"""
