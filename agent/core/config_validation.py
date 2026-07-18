# agent/core/config_validation.py

"""
Shared fail-loud-but-not-hard-fail JSON config reading.

Callers that read a config file (``harness.config.json``, ``.mcp.json``,
``.canary/company.json``, ...) have historically caught both ``OSError`` and
``json.JSONDecodeError`` in one blanket ``except`` and treated the result the
same as "file doesn't exist" — silently falling back to defaults. That
collapses two very different situations into one:

  - The file genuinely doesn't exist. Totally normal; fall back silently.
  - The file exists but is malformed or unreadable. The user has a broken
    config and deserves to know — silently treating it as absent produces
    wrong-but-confident output (e.g. "no harness project detected" when
    there plainly is one, just with a typo'd JSON file).

:func:`read_json_with_warning` distinguishes the two. It never raises: a
malformed/unreadable file degrades to ``(None, "<warning message>")`` rather
than an exception, so existing call sites can adopt it without introducing a
new failure mode. Callers are responsible for surfacing the warning message
(CLI output, log line, etc.) — this module only detects and describes the
problem.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


def read_json_with_warning(path: Path) -> tuple[Optional[dict], Optional[str]]:
    """Read and parse a JSON file, distinguishing "absent" from "malformed".

    Returns a ``(data, warning)`` tuple:

      - ``(None, None)`` — the file does not exist. Not an error; the
        caller should proceed as if there is no config.
      - ``(None, "<message>")`` — the file exists but could not be read or
        parsed. The caller should surface this warning to the user instead
        of silently treating the config as absent.
      - ``(data, None)`` — the file exists and parsed successfully.

    Never raises.
    """
    try:
        exists = path.exists()
    except OSError:
        # A broken symlink or similar can make even .exists() raise on some
        # platforms; treat it as "can't confirm presence" -> warn, don't crash.
        return None, f"{path} could not be accessed"

    if not exists:
        return None, None

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return None, f"{path} exists but could not be read: {e}"

    try:
        return json.loads(text), None
    except json.JSONDecodeError as e:
        return None, f"{path} exists but is not valid JSON: {e}"
