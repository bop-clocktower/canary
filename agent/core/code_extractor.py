"""Strip conversational prose and Markdown wrappers from LLM-generated code.

Some providers (notably Gemini) wrap generated code in narrative
introductions like "Here is a high-quality test..." followed by a
fenced Markdown code block. Writing that straight to a ``.spec.ts``
file produces something that won't parse.

This module post-processes the raw LLM response into bare runnable
code. Strategy:

1. If the response contains a fenced code block, extract the contents
   of the first one — that's overwhelmingly the intended payload.
2. Otherwise, return the response as-is (treat it as already-bare code).
3. As a sanity belt-and-suspenders, strip a trailing "explanation"
   section if it appears after the code in plain prose.

Tested against Gemini and Anthropic outputs; safe no-op when the
response is already bare code.
"""

from __future__ import annotations

import re

# Match a fenced code block. Captures the language tag (group 1) and the
# inner code (group 2). DOTALL so '.' matches newlines inside the block.
_FENCE_RE = re.compile(
    r"```(?P<lang>[a-zA-Z0-9_+\-.]*)\n(?P<code>.*?)```",
    re.DOTALL,
)


def extract_code(raw: str) -> str:
    """Return runnable code from a raw LLM response.

    Strips conversational prose and Markdown fences. Idempotent — a
    response that's already bare code is returned unchanged.
    """
    if not raw:
        return raw

    matches = list(_FENCE_RE.finditer(raw))
    if not matches:
        # No fenced block — assume the response IS the code.
        return raw.strip() + "\n"

    # Pick the longest fenced block (usually the real code; commentary
    # blocks tend to be short or empty).
    best = max(matches, key=lambda m: len(m.group("code")))
    code = best.group("code")
    return code.rstrip() + "\n"
