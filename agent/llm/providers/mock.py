# agent/llm/providers/mock.py

from typing import List, Dict, Any
from agent.llm.providers.base import BaseProvider

class MockProvider(BaseProvider):
    """
    Mock LLM provider for testing and development.
    """

    def generate(self, messages: List[Dict[str, str]]) -> str:
        """
        Returns a static mock response.
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
