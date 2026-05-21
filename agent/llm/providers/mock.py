# agent/llm/providers/mock.py

"""
Mock Provider - A deterministic LLM backend for testing and development.

This provider returns static, framework-appropriate stubs instead of calling
an external API, making it ideal for CI environments and local iteration.
"""

import re
from typing import List, Dict
from agent.llm.providers.base import BaseProvider


_STUBS: Dict[str, str] = {
    "playwright": """\
import {{ test, expect }} from '@playwright/test';

test('mock: generated test', async ({{ page }}) => {{
  // Oracle mock — replace with real assertions
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
}});
""",
    "vitest": """\
import {{ describe, it, expect }} from 'vitest';

describe('mock suite', () => {{
  it('mock: generated test', () => {{
    // Oracle mock — replace with real assertions
    expect(true).toBe(true);
  }});
}});
""",
    "pytest": """\
# Oracle mock — replace with real assertions
def test_mock_generated():
    assert True
""",
    "k6": """\
import http from 'k6/http';
import {{ check }} from 'k6';

export const options = {{ vus: 1, duration: '1s' }};

export default function () {{
  // Oracle mock — replace with real load-test logic
  const res = http.get('https://example.com');
  check(res, {{ 'status is 200': (r) => r.status === 200 }});
}}
""",
}

_FRAMEWORK_RE = re.compile(r"^Framework:\s*(\w+)", re.MULTILINE)


class MockProvider(BaseProvider):
    """Mock LLM provider — returns a framework-appropriate stub without hitting an API."""

    def generate(self, messages: List[Dict[str, str]]) -> str:
        user_msg = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"),
            "",
        )
        match = _FRAMEWORK_RE.search(user_msg)
        framework = match.group(1).lower() if match else "playwright"
        stub = _STUBS.get(framework, _STUBS["playwright"])
        return f"# Oracle mock (provider=mock, framework={framework})\n{stub}"
