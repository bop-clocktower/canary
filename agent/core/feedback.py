"""Pre-filled GitHub issue feedback bundling for Oracle generations."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from urllib.parse import quote

FEEDBACK_REPO = os.environ.get(
    "ORACLE_FEEDBACK_REPO", "bri-stevenski/oracle-test-ai-agent"
)
_MAX_URL_LEN = 8000
_TRUNCATE_MARKER = "\n\n[...truncated]"


@dataclass(frozen=True)
class FeedbackPayload:
    prompt: str
    test_type: str
    framework: str
    provider: str
    model: str
    output_file: str

    def as_dict(self) -> dict:
        return asdict(self)


def _body_template(payload: FeedbackPayload, prompt_override: Optional[str] = None) -> str:
    """Render the issue body. ``prompt_override`` lets callers shrink the prompt."""
    prompt = prompt_override if prompt_override is not None else payload.prompt
    return (
        "> ⚠️ **This issue will be public.** Review the prompt below and remove "
        "any customer IDs, internal endpoints, credentials, or stack traces "
        "before submitting.\n\n"
        "## What did Oracle do?\n"
        f"- **Prompt:** {prompt}\n"
        f"- **Test type:** {payload.test_type}\n"
        f"- **Framework:** {payload.framework}\n"
        f"- **Provider:** {payload.provider}\n"
        f"- **Model:** {payload.model}\n"
        f"- **Output file:** `{payload.output_file}`\n\n"
        "## What went wrong / what would you change?\n"
        "<!-- describe the issue, paste snippets, attach files -->\n"
    )


def build_issue_url(payload: FeedbackPayload, repo: Optional[str] = None) -> str:
    """Construct a pre-filled GitHub issue URL bundling generation context.

    The issue body is capped at ``_MAX_URL_LEN`` bytes after percent-encoding.
    When the full body would exceed the cap, the prompt is truncated in the
    unencoded body — never on the encoded string — so the resulting URL
    cannot land mid-``%XX`` triplet.
    """
    repo = repo or FEEDBACK_REPO
    title = f"[oracle feedback] {payload.framework}/{payload.test_type}"
    base = f"https://github.com/{repo}/issues/new?title={quote(title)}&body="
    budget = _MAX_URL_LEN - len(base)

    body = _body_template(payload)
    encoded_body = quote(body)
    if len(encoded_body) <= budget:
        return base + encoded_body

    # Shrink the unencoded prompt until the percent-encoded body fits.
    trunc_suffix = " [...truncated]"
    prompt_chars = len(payload.prompt)
    while prompt_chars > 0:
        truncated = payload.prompt[:prompt_chars] + trunc_suffix
        body = _body_template(payload, prompt_override=truncated)
        encoded_body = quote(body)
        if len(encoded_body) <= budget:
            return base + encoded_body
        prompt_chars //= 2

    # Prompt is fully dropped; the structured fields alone must fit.
    body = _body_template(payload, prompt_override=trunc_suffix)
    return base + quote(body)


_STATE_DIR = ".oracle"
_STATE_FILE = "last_generation.json"


def _state_path() -> Path:
    return Path.cwd() / _STATE_DIR / _STATE_FILE


def record_last_generation(payload: FeedbackPayload) -> Path:
    """Persist the latest generation payload for `oracle feedback`."""
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload.as_dict(), indent=2) + "\n")
    return path


def load_last_generation() -> Optional[FeedbackPayload]:
    """Load the last recorded generation payload, or None if absent or corrupt.

    Mirrors the record path's best-effort behavior — a stale or malformed
    ``.oracle/last_generation.json`` (truncated write, old schema, hand-edited)
    yields ``None`` rather than a traceback.
    """
    path = _state_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return FeedbackPayload(**data)
    except (OSError, ValueError, TypeError):
        return None
