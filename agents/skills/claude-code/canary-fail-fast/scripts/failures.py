"""Heuristic failure categorization (self-contained, pure).

Order matters — the most distinctive signals are checked first so 4xx/5xx
status-code patterns don't swallow schema errors that happen to mention a
status code in a response preview.
"""

from __future__ import annotations

import re
from typing import Tuple

FAILURE_CATEGORIES: Tuple[str, ...] = (
    "schema",
    "auth",
    "server",
    "client",
    "timeout",
    "network",
    "other",
)

_RULES = [
    ("schema", re.compile(
        r'ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b',
        re.IGNORECASE,
    )),
    ("auth", re.compile(
        r"\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired",
        re.IGNORECASE,
    )),
    ("timeout", re.compile(
        r"timeout|timed out|etimedout|deadline exceeded",
        re.IGNORECASE,
    )),
    ("network", re.compile(
        r"econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed",
        re.IGNORECASE,
    )),
    ("server", re.compile(
        r"\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout",
        re.IGNORECASE,
    )),
    ("client", re.compile(
        r"\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict",
        re.IGNORECASE,
    )),
]


def categorize_failure(error: str | None) -> str:
    if not error:
        return "other"
    for category, pattern in _RULES:
        if pattern.search(error):
            return category
    return "other"
