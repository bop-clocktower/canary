# agent/core/environment_detect.py

"""Context-aware environment & persona detection (issue #341).

Canary tailors which skills load, which user pool it queries, and how it
phrases output based on *who* is driving and *what* they are testing. This
module gathers that context from cheap, local, deterministic signals so a
consumer (currently the MCP ``analyze_file`` path) can attach it to its
response without any network call or model round-trip.

Three detection paths are implemented here — the concrete, testable ones:

1. **BASE_URL** — read from ``.env`` (canonical ``BASE_URL`` plus common
   aliases), falling back to a literal ``baseURL`` in ``playwright.config.*``.
2. **Suite hints** — parse ``playwright.config.*`` for ``testDir`` / project
   names / ``testMatch`` to classify the suite as e2e / component / api.
3. **User level (SDET vs manual)** — a *transparent, documented* heuristic
   over the current working directory and the caller-supplied list of open
   files. Every contributing signal is returned alongside the verdict so the
   decision is auditable, never magic.

Deferred: reading the active **browser tab URL** from an LLM browser
extension (path (a) in #341). That depends on the Chrome Extension MCP
Bridge tracked in issue #343, which does not exist yet.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# Ordered by trust: the canonical name wins over framework-specific aliases.
_BASE_URL_KEYS: Tuple[str, ...] = (
    "BASE_URL",
    "PLAYWRIGHT_BASE_URL",
    "E2E_BASE_URL",
    "APP_URL",
)

_PLAYWRIGHT_CONFIGS: Tuple[str, ...] = (
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mts",
    "playwright.config.mjs",
    "playwright.config.cts",
    "playwright.config.cjs",
)

# Extensions that indicate someone is writing/reading code or automated tests.
_CODE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py",
    ".java", ".rb", ".go", ".cs",
}
# Extensions that indicate manual test artefacts (plans, case sheets, notes).
_MANUAL_SUFFIXES = {".md", ".csv", ".xlsx", ".xls", ".docx", ".doc", ".pdf", ".txt"}

# Config filenames whose mere presence marks an automation-savvy project.
_TEST_CONFIG_FILES = (
    "playwright.config.ts", "playwright.config.js",
    "vitest.config.ts", "vitest.config.js",
    "pytest.ini", "jest.config.js", "jest.config.ts",
    "cypress.config.ts", "cypress.config.js",
)
_PROJECT_MANIFESTS = ("package.json", "pyproject.toml", "requirements.txt")

# cwd path fragments that lean manual.
_MANUAL_DIR_HINTS = ("manual", "test-case", "testcase", "test-plan", "testplan")


@dataclass
class EnvironmentContext:
    """Detected environment/persona context for the current invocation.

    All fields are optional/degradable: absent signals leave sensible
    ``None`` / ``"unknown"`` defaults rather than raising.
    """

    base_url: Optional[str] = None
    base_url_source: Optional[str] = None  # ".env" | "playwright.config" | None
    suite_type: Optional[str] = None       # "e2e" | "component" | "api" | None
    suite_hints: List[str] = field(default_factory=list)
    user_level: str = "unknown"            # "sdet" | "manual" | "unknown"
    user_level_signals: List[str] = field(default_factory=list)
    user_level_confidence: float = 0.0

    def to_dict(self) -> Dict[str, object]:
        """Return a JSON-serialisable view for embedding in MCP responses."""
        return {
            "base_url": self.base_url,
            "base_url_source": self.base_url_source,
            "suite_type": self.suite_type,
            "suite_hints": list(self.suite_hints),
            "user_level": self.user_level,
            "user_level_signals": list(self.user_level_signals),
            "user_level_confidence": round(self.user_level_confidence, 3),
        }


# ---------------------------------------------------------------------------
# Path 2 (issue path b): BASE_URL from .env / playwright.config.*
# ---------------------------------------------------------------------------

def _parse_dotenv_base_url(root: Path) -> Optional[str]:
    """Return the first BASE_URL-family value from ``.env``, or None."""
    path = root / ".env"
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None

    found: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key in _BASE_URL_KEYS and value and key not in found:
            found[key] = value

    for key in _BASE_URL_KEYS:  # honour trust order regardless of file order
        if key in found:
            return found[key]
    return None


def _parse_config_base_url(root: Path) -> Optional[str]:
    """Return a *literal* ``baseURL`` from playwright.config.*, or None.

    A ``process.env.*`` indirection is deliberately ignored — there is no
    literal URL to report, and inventing one would be misleading.
    """
    for name in _PLAYWRIGHT_CONFIGS:
        path = root / name
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        match = re.search(r"""baseURL\s*:\s*['"]([^'"]+)['"]""", text)
        if match:
            return match.group(1)
    return None


def detect_base_url(project_root: str = ".") -> Tuple[Optional[str], Optional[str]]:
    """Detect the target BASE_URL for the project.

    Precedence: an explicit ``.env`` value (most likely the one actually
    exported at runtime) beats a literal in the Playwright config.

    Returns:
        ``(url, source)`` where source is ``".env"``,
        ``"playwright.config"``, or ``None`` when nothing was found.
    """
    root = Path(project_root).resolve()

    env_url = _parse_dotenv_base_url(root)
    if env_url:
        return env_url, ".env"

    cfg_url = _parse_config_base_url(root)
    if cfg_url:
        return cfg_url, "playwright.config"

    return None, None


# ---------------------------------------------------------------------------
# Path 2 (issue path b): suite hints from playwright.config.*
# ---------------------------------------------------------------------------

def parse_playwright_suite_hints(
    project_root: str = ".",
) -> Tuple[Optional[str], List[str]]:
    """Infer suite type and collect free-form hints from a Playwright config.

    Reads ``testDir``, ``testMatch``, and ``projects[].name`` and classifies
    the suite as ``"component"``, ``"api"``, or ``"e2e"``. Playwright is an
    end-to-end tool by default, so a config that is present but gives no
    stronger signal is classified ``"e2e"``.

    Returns:
        ``(suite_type, hints)``. ``(None, [])`` when no Playwright config
        exists.
    """
    root = Path(project_root).resolve()
    config_text: Optional[str] = None
    for name in _PLAYWRIGHT_CONFIGS:
        path = root / name
        if path.exists():
            try:
                config_text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                config_text = ""
            break

    if config_text is None:
        return None, []

    hints: List[str] = []

    test_dir_match = re.search(r"""testDir\s*:\s*['"]([^'"]+)['"]""", config_text)
    if test_dir_match:
        hints.append(test_dir_match.group(1))

    test_match = re.search(r"""testMatch\s*:\s*['"]([^'"]+)['"]""", config_text)
    if test_match:
        hints.append(test_match.group(1))

    for proj in re.findall(r"""name\s*:\s*['"]([^'"]+)['"]""", config_text):
        hints.append(proj)

    blob = " ".join(hints).lower()
    if "component" in blob or ".ct." in blob or "/ct" in blob:
        suite_type = "component"
    elif "api" in blob:
        suite_type = "api"
    else:
        # Config present but no stronger cue: Playwright defaults to e2e.
        suite_type = "e2e"

    return suite_type, hints


# ---------------------------------------------------------------------------
# Path 3 (issue path c): SDET-vs-manual user-level heuristic
# ---------------------------------------------------------------------------

def detect_user_level(
    cwd: str,
    open_files: Optional[Sequence[str]] = None,
) -> Tuple[str, List[str], float]:
    """Classify the driver as an SDET or a manual tester — transparently.

    This is an intentionally simple, *auditable* scoring heuristic, not a
    model. Each signal contributes one point to either the SDET or the
    manual tally, and every fired signal is returned so a consumer (or a
    human) can see exactly why the verdict came out the way it did.

    SDET-leaning signals:
        - an open file with a code/test extension (``.spec.ts``, ``.py`` …)
        - a test-framework config file in ``cwd`` (playwright/vitest/pytest …)
        - a project manifest (``package.json`` / ``pyproject.toml`` …)

    Manual-leaning signals:
        - an open file that is a doc/spreadsheet artefact (``.md``/``.csv`` …)
        - a ``cwd`` path fragment such as ``manual`` or ``test-cases``

    Returns:
        ``(level, signals, confidence)`` where ``level`` is ``"sdet"``,
        ``"manual"``, or ``"unknown"`` (a tie or no signal), ``signals`` is
        the human-readable list of contributing cues, and ``confidence`` is
        ``|sdet - manual| / (sdet + manual)`` in ``[0, 1]`` (``0.0`` when no
        signal fired).
    """
    signals: List[str] = []
    sdet = 0
    manual = 0

    files = list(open_files or [])
    for f in files:
        suffix = Path(f).suffix.lower()
        if suffix in _CODE_SUFFIXES:
            sdet += 1
            signals.append(f"code/test file open: {f}")
        elif suffix in _MANUAL_SUFFIXES:
            manual += 1
            signals.append(f"manual artefact open: {f}")

    cwd_path = Path(cwd)
    cwd_lower = str(cwd_path).lower()
    if any(hint in cwd_lower for hint in _MANUAL_DIR_HINTS):
        manual += 1
        signals.append("cwd path suggests manual testing")

    if cwd_path.exists():
        for cfg in _TEST_CONFIG_FILES:
            if (cwd_path / cfg).exists():
                sdet += 1
                signals.append(f"test-framework config present: {cfg}")
                break
        for manifest in _PROJECT_MANIFESTS:
            if (cwd_path / manifest).exists():
                sdet += 1
                signals.append(f"project manifest present: {manifest}")
                break

    total = sdet + manual
    if total == 0:
        return "unknown", [], 0.0

    confidence = abs(sdet - manual) / total
    if sdet > manual:
        return "sdet", signals, confidence
    if manual > sdet:
        return "manual", signals, confidence
    return "unknown", signals, confidence


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

def detect_environment(
    project_root: str = ".",
    cwd: Optional[str] = None,
    open_files: Optional[Sequence[str]] = None,
) -> EnvironmentContext:
    """Run every implemented detection path and return the combined context.

    Args:
        project_root: Project root scanned for ``.env`` / Playwright config.
        cwd: Working directory used by the user-level heuristic. Defaults to
            ``project_root`` when omitted.
        open_files: Caller-supplied list of open/edited file paths (the MCP
            consumer knows these; this module never guesses them).
    """
    base_url, base_url_source = detect_base_url(project_root)
    suite_type, suite_hints = parse_playwright_suite_hints(project_root)
    level, level_signals, level_conf = detect_user_level(
        cwd or project_root, open_files
    )

    return EnvironmentContext(
        base_url=base_url,
        base_url_source=base_url_source,
        suite_type=suite_type,
        suite_hints=suite_hints,
        user_level=level,
        user_level_signals=level_signals,
        user_level_confidence=level_conf,
    )
