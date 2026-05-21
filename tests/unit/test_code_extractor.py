"""Strip conversational prose / markdown from LLM responses (#58)."""

from agent.core.code_extractor import extract_code


def test_bare_code_passes_through_unchanged():
    """Already-clean code shouldn't be mangled."""
    code = "import { test } from '@playwright/test';\ntest('x', async () => {});"
    out = extract_code(code)
    assert "import { test }" in out
    assert "test('x'" in out


def test_extracts_from_fenced_block_with_language_tag():
    """The Gemini failure mode: prose intro + fenced typescript block."""
    raw = """Here is a high-quality test:

```typescript
import { test, expect } from '@playwright/test';

test('order is created', async ({ request }) => {
  const res = await request.post('/api/orders');
  expect(res.status()).toBe(201);
});
```

Let me know if you'd like adjustments.
"""
    out = extract_code(raw)
    assert "Here is a high-quality" not in out
    assert "Let me know if" not in out
    assert "import { test, expect }" in out
    assert "expect(res.status()).toBe(201)" in out
    # Closing fence should be gone too
    assert "```" not in out


def test_extracts_from_fenced_block_without_language_tag():
    """Some providers omit the language hint."""
    raw = "Some prose.\n\n```\nprint('hi')\n```\n"
    out = extract_code(raw)
    assert out.strip() == "print('hi')"


def test_picks_longest_fence_when_multiple():
    """When the response has both a short commentary fence and the real
    code fence, the long one wins."""
    raw = """Briefly: `foo` returns 42.

```text
just a placeholder
```

Here's the code:

```python
def foo():
    \"\"\"Returns 42.\"\"\"
    return 42


def bar():
    return foo() + 1
```
"""
    out = extract_code(raw)
    assert "def foo()" in out
    assert "def bar()" in out
    assert "just a placeholder" not in out


def test_empty_response_returns_empty():
    assert extract_code("") == ""


def test_response_with_no_fences_kept_intact():
    """Bare code without any markdown structure round-trips cleanly."""
    raw = "function add(a, b) {\n  return a + b;\n}"
    out = extract_code(raw)
    assert "function add(a, b)" in out
    assert "return a + b" in out
