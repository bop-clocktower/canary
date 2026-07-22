"""Line scanner: turns test sources into temporal-dependency findings (pure).

Regex/AST-lite by design -- no TypeScript parser dependency, no imports outside
the standard library. See SKILL.md for the fidelity limits that choice buys.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from rules import FROZEN_CLOCK_MARKERS, RULES

SNIPPET_LIMIT = 120

# Extensions the scanner understands at all.
SUPPORTED_SUFFIXES = (".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")

# Directories never worth walking.
_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".mypy_cache", ".pytest_cache", ".tox",
}

# Directory names that make every source file inside them a test file.
_TEST_DIRS = {"tests", "test", "__tests__", "e2e", "spec"}

# Line prefixes treated as commented-out code rather than live code.
_COMMENT_PREFIXES = ("#", "//", "*", "/*", '"""', "'''")


@dataclass
class Finding:
    """One flagged line."""

    file: str
    line: int
    rule_id: str
    severity: str
    snippet: str
    why: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "rule_id": self.rule_id,
            "severity": self.severity,
            "snippet": self.snippet,
            "why": self.why,
        }


@dataclass
class ScanResult:
    """Everything a run produced, plus what it looked at."""

    findings: list = field(default_factory=list)
    files_scanned: int = 0


def frozen_clock_markers(text: str) -> list:
    """Return the frozen-clock idioms present in `text`, in catalog order.

    A non-empty result suppresses every clock-dependent rule for the whole
    file. File-wide (not block-scoped) on purpose: `vi.useFakeTimers()` in a
    `beforeEach` governs tests declared above it, and a scope-accurate answer
    needs a real parser.
    """
    return [marker for marker in FROZEN_CLOCK_MARKERS if marker in text]


def is_test_file(path: Path) -> bool:
    """True when a path looks like a test file by name or containing directory."""
    if path.suffix not in SUPPORTED_SUFFIXES:
        return False
    name = path.name
    stem = path.stem
    if ".test." in name or ".spec." in name:
        return True
    if stem.startswith("test_") or stem.endswith("_test"):
        return True
    return any(part in _TEST_DIRS for part in path.parts[:-1])


def _is_comment(stripped: str) -> bool:
    return stripped.startswith(_COMMENT_PREFIXES)


def scan_text(text: str, file: str = "<text>") -> list:
    """Scan source text, returning findings ordered by line then rule id."""
    frozen = bool(frozen_clock_markers(text))
    findings = []
    for number, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or _is_comment(stripped):
            continue
        for rule in RULES:
            if frozen and rule.clock_dependent:
                continue
            match = rule.pattern.search(stripped)
            if not match:
                continue
            if rule.keep is not None and not rule.keep(match):
                continue
            findings.append(
                Finding(
                    file=file,
                    line=number,
                    rule_id=rule.rule_id,
                    severity=rule.severity,
                    snippet=stripped[:SNIPPET_LIMIT],
                    why=rule.why,
                )
            )
    return findings


def scan_file(path: Path) -> list:
    """Scan one file. Unreadable or non-UTF-8 files yield no findings."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return scan_text(text, str(path))


def _iter_files(root: Path):
    """Yield the files a path contributes: explicit files win, dirs are filtered.

    An explicitly named file is scanned even when it does not look like a test
    (the caller asked for it); a directory walk only visits test files.
    """
    if root.is_file():
        if root.suffix in SUPPORTED_SUFFIXES:
            yield root
        return
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        if is_test_file(path):
            yield path


def scan_paths(paths) -> ScanResult:
    """Scan every given file/directory, de-duplicating overlapping paths."""
    seen: set = set()
    findings = []
    scanned = 0
    for entry in paths:
        for path in _iter_files(Path(entry)):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            scanned += 1
            findings.extend(scan_file(path))
    findings.sort(key=lambda f: (f.file, f.line, f.rule_id))
    return ScanResult(findings=findings, files_scanned=scanned)
