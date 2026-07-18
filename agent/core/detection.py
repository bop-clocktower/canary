# agent/core/detection.py

"""
Fail-loud auto-detection messaging.

Several CLI paths auto-detect something (a test framework, a doctor
persona) and, when detection is uncertain, used to silently fall back to
``unknown`` / ``None`` or a bare "flag required" failure. That erodes user
trust: the caller has no idea *what* was being detected, *why* it failed,
or *what to do next*. It also caused live bugs — a WebdriverIO/Appium
project silently detected as ``Framework: unknown`` (issue #295), and
``canary doctor`` failing on a missing ``--persona`` with no discoverable
vocabulary (issue #294).

:func:`uncertain_detection_message` renders one clear, actionable message
from the pieces a call site has on hand, so every uncertain-detection path
reads the same way instead of each inventing its own ad hoc string. It is
pure string-building — it never prints, raises, or decides control flow;
the caller owns those.
"""

from __future__ import annotations

from typing import Optional, Sequence


def uncertain_detection_message(
    what: str,
    *,
    reason: Optional[str] = None,
    candidates: Optional[Sequence[str]] = None,
    override_hint: Optional[str] = None,
) -> str:
    """Build a clear, actionable message for an uncertain/failed detection.

    Args:
        what: What we tried to detect, as a human-readable noun phrase
            (e.g. ``"test framework"``, ``"doctor persona"``).
        reason: Why detection is uncertain (e.g. ``"no config file or
            dependency matched"``). Optional.
        candidates: The known vocabulary of valid values, when the engine
            knows it (e.g. the supported frameworks, the persona tags
            declared by overlays). An empty or missing list omits the
            "Known …" clause entirely.
        override_hint: How to specify the value explicitly (e.g.
            ``"--framework <name>"``). Optional.

    Returns:
        A single multi-line string. Always names ``what`` and always gives
        at least one next step when an override hint or candidate list is
        provided — never a bare ``unknown``.
    """
    parts = [f"Could not confidently auto-detect the {what}."]
    if reason:
        parts.append(f"Reason: {reason}.")
    if candidates:
        joined = ", ".join(candidates)
        parts.append(f"Known {what}(s): {joined}.")
    if override_hint:
        parts.append(f"Set it explicitly with {override_hint}.")
    return " ".join(parts)
