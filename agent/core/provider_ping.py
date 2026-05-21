"""No-cost API-key validation per provider.

Default path uses each provider's metadata-only ``models.list`` endpoint
to authenticate the key without consuming paid tokens. If that endpoint
returns a non-auth error (e.g. 404 after a future SDK deprecation, 429,
5xx) we retry once and then fall back to a single ``max_tokens=1``
completion call so a transient ``models.list`` outage does not look like
an invalid-key error to the tester. 401/403 short-circuits regardless —
those *are* the invalid-key signal we're after.

Behavior can be overridden per provider via ``ORACLE_PING_METHOD``:

- ``models`` — only call ``models.list`` (legacy behavior)
- ``completion`` — only call the 1-token completion fallback
- ``auto`` (default) — ``models.list`` first, then completion fallback
"""

import os
import time
from typing import Optional, Tuple


_KEY_URLS = {
    "anthropic": "https://console.anthropic.com/settings/keys",
    "openai":    "https://platform.openai.com/api-keys",
    "codex":     "https://platform.openai.com/api-keys",
    "gemini":    "https://aistudio.google.com/app/apikey",
}

# 10s ceiling so a captive portal / bad DNS can't hang the onboarding
# flow past its <2-minute budget.
_TIMEOUT_S = 10.0

# HTTP statuses we treat as "key is invalid" — no point retrying or
# falling back; user must rotate their key.
_AUTH_STATUSES = frozenset({401, 403})

# Statuses that mean "endpoint is unhappy, but not because of the key" —
# worth one retry and a fallback try.
_TRANSIENT_STATUSES = frozenset({404, 408, 425, 429, 500, 502, 503, 504})


def ping(provider: str, api_key: Optional[str] = None) -> Tuple[bool, str]:
    """Validate an API key. Returns ``(ok, message)``.

    On failure, the message ends with the provider's key-management URL.
    """
    provider = provider.lower()
    if provider == "mock":
        return True, "mock provider — no auth required"

    method = os.getenv("ORACLE_PING_METHOD", "auto").lower()
    if method not in ("auto", "models", "completion"):
        method = "auto"

    if method in ("auto", "models"):
        ok, msg, status = _try_models_list(provider, api_key)
        if ok:
            return True, msg
        if status in _AUTH_STATUSES:
            return False, _invalid_key_msg(provider, msg)
        if method == "models":
            return False, _failed_msg(provider, msg)
        # Transient or unknown — fall through to completion fallback

    if method in ("auto", "completion"):
        ok, msg, status = _try_completion(provider, api_key)
        if ok:
            return True, msg
        if status in _AUTH_STATUSES:
            return False, _invalid_key_msg(provider, msg)
        return False, _failed_msg(provider, msg)

    return False, f"unknown provider: {provider}"


def _try_models_list(provider: str, api_key: Optional[str]) -> Tuple[bool, str, Optional[int]]:
    """Try ``models.list`` once with one retry on transient errors."""
    last_exc: Optional[BaseException] = None
    for attempt in range(2):
        try:
            if provider == "anthropic":
                from anthropic import Anthropic
                client = Anthropic(api_key=api_key, timeout=_TIMEOUT_S)
                next(iter(client.models.list()), None)
                return True, "anthropic: key valid (models.list)", None
            if provider in ("openai", "codex"):
                from openai import OpenAI
                client = OpenAI(api_key=api_key, timeout=_TIMEOUT_S)
                next(iter(client.models.list()), None)
                return True, f"{provider}: key valid (models.list)", None
            if provider == "gemini":
                from google import genai
                # google-genai's Client does not accept a top-level timeout
                # kwarg; the SDK uses urllib3 defaults.
                client = genai.Client(api_key=api_key)
                next(iter(client.models.list()), None)
                return True, "gemini: key valid (models.list)", None
            return False, f"unknown provider: {provider}", None
        except BaseException as e:
            last_exc = e
            status = _extract_status(e)
            if status in _AUTH_STATUSES:
                return False, _exc_summary(e), status
            if status not in _TRANSIENT_STATUSES or attempt == 1:
                return False, _exc_summary(e), status
            time.sleep(0.25)
    # Unreachable, but keep mypy happy.
    return False, _exc_summary(last_exc) if last_exc else "unknown", None


def _try_completion(provider: str, api_key: Optional[str]) -> Tuple[bool, str, Optional[int]]:
    """Fallback: 1-token completion call. Costs ~nothing but isn't free."""
    try:
        if provider == "anthropic":
            from anthropic import Anthropic
            client = Anthropic(api_key=api_key, timeout=_TIMEOUT_S)
            # Smallest known-available model; the call only needs to
            # authenticate, not produce useful output.
            client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1,
                messages=[{"role": "user", "content": "ok"}],
            )
            return True, "anthropic: key valid (1-token completion)", None
        if provider in ("openai", "codex"):
            from openai import OpenAI
            client = OpenAI(api_key=api_key, timeout=_TIMEOUT_S)
            client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=1,
                messages=[{"role": "user", "content": "ok"}],
            )
            return True, f"{provider}: key valid (1-token completion)", None
        if provider == "gemini":
            from google import genai
            client = genai.Client(api_key=api_key)
            client.models.generate_content(
                model="gemini-flash-latest",
                contents="ok",
            )
            return True, "gemini: key valid (1-token completion)", None
        return False, f"unknown provider: {provider}", None
    except BaseException as e:
        return False, _exc_summary(e), _extract_status(e)


def _extract_status(exc: BaseException) -> Optional[int]:
    """Best-effort HTTP status extraction across SDK exception shapes."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    resp = getattr(exc, "response", None)
    if resp is not None:
        status = getattr(resp, "status_code", None) or getattr(resp, "status", None)
        if isinstance(status, int):
            return status
    # Fall back to parsing the message for a 3-digit status.
    msg = str(exc)
    for token in ("401", "403", "404", "408", "425", "429", "500", "502", "503", "504"):
        if token in msg:
            return int(token)
    return None


def _exc_summary(exc: BaseException) -> str:
    return f"{exc.__class__.__name__}: {exc}"


def _invalid_key_msg(provider: str, detail: str) -> str:
    url = _KEY_URLS.get(provider, "(no URL)")
    return f"{provider}: invalid key ({detail}). Rotate at {url}"


def _failed_msg(provider: str, detail: str) -> str:
    url = _KEY_URLS.get(provider, "(no URL)")
    return f"{provider}: validation failed ({detail}). Get a key at {url}"
