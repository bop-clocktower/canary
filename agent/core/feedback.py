"""In-CLI feedback / issue reporting (#345).

`canary feedback` lowers the discoverability barrier that makes feedback
evaporate at submission time: instead of hunting for where the tracker lives, a
user runs one command and gets a **pre-filled GitHub issue** with non-sensitive
context already attached. This module is the pure, testable core — it builds the
payload and URL; the CLI command handles I/O, confirmation, and opening a
browser.

Privacy: context is limited to version / OS / Python / install method. It never
reads environment variables or file contents.
"""

from __future__ import annotations

import platform
import sys
from urllib.parse import urlencode

# The public issue tracker (from npm/package.json `repository`).
TRACKER_URL = "https://github.com/bop-clocktower/canary"

VALID_CATEGORIES = ("bug", "ux", "docs", "idea")


def _canary_version() -> str:
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as _pkg_version

    try:
        return _pkg_version("canary-test-ai")
    except PackageNotFoundError:
        return "unknown"


def _install_method() -> str:
    """Best-effort install-method label — never fails, never inspects secrets."""
    exe = (sys.executable or "").lower()
    if "pipx" in exe:
        return "pipx"
    return "pip/npm"


def collect_context() -> dict[str, str]:
    """Non-sensitive diagnostic context to attach to a report.

    Deliberately excludes environment variables and file contents — only the
    coarse runtime facts a maintainer needs to triage a CLI report.
    """
    return {
        "version": _canary_version(),
        "os": f"{platform.system()} {platform.release()}".strip(),
        "python": platform.python_version(),
        "install": _install_method(),
    }


def build_issue_url(category: str, message: str, context: dict[str, str]) -> str:
    """A pre-filled GitHub 'new issue' URL: category in the title, message +
    context in the body, category as a label. All parts are URL-encoded."""
    title = f"[{category}] {message[:60]}".strip()
    body_lines = [
        message,
        "",
        "---",
        "_Submitted via `canary feedback`._",
        "",
        "**Environment**",
    ]
    body_lines += [f"- {k}: {v}" for k, v in context.items()]
    query = urlencode({"title": title, "body": "\n".join(body_lines), "labels": category})
    return f"{TRACKER_URL}/issues/new?{query}"


def build_feedback(message: str, category: str) -> dict:
    """Bundle a report: message, category, context, and the pre-filled URL."""
    context = collect_context()
    return {
        "message": message,
        "category": category,
        "context": context,
        "issue_url": build_issue_url(category, message, context),
    }
