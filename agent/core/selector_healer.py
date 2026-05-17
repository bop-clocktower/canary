# agent/core/selector_healer.py

import re
import zipfile
from pathlib import Path

_DOM_MAX_CHARS = 3_500

# Signals that indicate a UI-selector failure rather than a logic/assertion failure.
_FAILURE_SIGNALS = (
    "TimeoutError",
    "waiting for",
    "locator(",
    "selector",
    "strict mode violation",
    "not attached",
    "not visible",
    "element not found",
    "page.click",
    "getByRole",
    "getByText",
    "getByTestId",
)

# Ordered list of (label, regex) pairs for selector extraction.
# Tried in order; first match wins.
_SELECTOR_PATTERNS = [
    ("locator",    r"""locator\(['"](.+?)['"]\)"""),
    ("getByRole",  r"""getByRole\(['"](\w+)['"]"""),
    ("getByText",  r"""getByText\(['"](.+?)['"]\)"""),
    ("getByTestId",r"""getByTestId\(['"](.+?)['"]\)"""),
    ("page.click", r"""page\.click\(['"](.+?)['"]\)"""),
    ("page.fill",  r"""page\.fill\(['"](.+?)['"]\)"""),
    ("waiting",    r"""waiting for selector ['"](.+?)['"]"""),
]


class SelectorHealer:
    """Detects selector-related UI test failures and builds DOM-aware fix prompts."""

    # ── public API ────────────────────────────────────────────────────────

    def is_selector_failure(self, error: str) -> bool:
        """Return True when the error looks like a broken UI selector."""
        if not error:
            return False
        lower = error.lower()
        return any(sig.lower() in lower for sig in _FAILURE_SIGNALS)

    def extract_failing_selector(self, error: str) -> str | None:
        """Return the selector string from the error, or None if not found."""
        for _label, pattern in _SELECTOR_PATTERNS:
            m = re.search(pattern, error)
            if m:
                return m.group(1)
        return None

    def dom_context_from_report(self, report_dir: Path) -> str:
        """
        Extract a DOM snippet from a Playwright report directory.

        Checks (in order):
        1. Loose *.html snapshot files directly in report_dir
        2. *.zip trace archives whose ``snapshots/`` entries contain HTML
        """
        if not report_dir.exists():
            return ""

        # 1. Loose HTML snapshots
        for html_file in sorted(report_dir.glob("*.html")):
            content = self._read_truncated(html_file)
            if content:
                return content

        # 2. Trace zip archives
        for zip_path in sorted(report_dir.glob("*.zip")):
            snippet = self._dom_from_zip(zip_path)
            if snippet:
                return snippet

        return ""

    def build_heal_prompt(
        self,
        *,
        user_prompt: str,
        framework: str,
        original_code: str,
        error: str,
        failing_selector: str | None,
        dom_context: str,
    ) -> str:
        """Build a selector-focused fix prompt, optionally enriched with DOM context."""
        selector_section = (
            f"\n--- FAILING SELECTOR ---\n{failing_selector}\n"
            if failing_selector
            else ""
        )
        dom_section = (
            f"\n--- DOM SNAPSHOT (page state at failure) ---\n{dom_context}\n"
            if dom_context
            else ""
        )

        return f"""You are Oracle, a senior test automation engineer.
A {framework} test has FAILED due to a brittle or broken UI selector.

--- REQUIREMENT ---
{user_prompt}

--- ORIGINAL CODE ---
{original_code}

--- ERROR OUTPUT ---
{error}
{selector_section}{dom_section}
--- TASK ---
Fix the selector(s) so the test passes reliably.

Guidelines:
- Prefer data-testid attributes over CSS classes or XPath
- Use ARIA roles and accessible names where data-testid is unavailable
- Avoid position-based selectors (nth-child, index)
- If a DOM snapshot is provided, use it to find the correct selector
- Maintain all original test logic; only change selectors
- Return ONLY the code, no explanation
"""

    # ── private helpers ───────────────────────────────────────────────────

    def _read_truncated(self, path: Path) -> str:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            return text[:_DOM_MAX_CHARS]
        except OSError:
            return ""

    def _dom_from_zip(self, zip_path: Path) -> str:
        try:
            with zipfile.ZipFile(zip_path) as zf:
                for name in zf.namelist():
                    if name.startswith("snapshots/") and name.endswith(".html"):
                        with zf.open(name) as fh:
                            return fh.read(_DOM_MAX_CHARS).decode("utf-8", errors="ignore")
        except (zipfile.BadZipFile, OSError):
            pass
        return ""
