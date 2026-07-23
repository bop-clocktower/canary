"""Tier-1 static scanner: test sources -> shared-state suspect findings (pure).

AST-lite by design -- no test execution, no parser dependency, standard library
only -- so it ships wherever `python3` does and runs cheaply on every PR. Two
rules (SV001, SV002) need whole-file context, so the scan is two-pass: a
file-level pass for those, plus a line pass for the purely local rules (SV003,
SV004). See SKILL.md for the fidelity limits this buys.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import rules

SNIPPET_LIMIT = 120

SUPPORTED_SUFFIXES = (".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")

_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".mypy_cache", ".pytest_cache", ".tox",
}

_TEST_DIRS = {"tests", "test", "__tests__", "e2e", "spec"}

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


def _make(file: str, line: int, rule_id: str, snippet: str) -> Finding:
    return Finding(
        file=file,
        line=line,
        rule_id=rule_id,
        severity=rules.SEVERITY[rule_id],
        snippet=snippet[:SNIPPET_LIMIT],
        why=rules.WHY[rule_id],
    )


def _sv001_module_mutables(lines: list, file: str, is_py: bool, text: str) -> list:
    """Module-level mutable declarations that some line later mutates in place."""
    decl_re = rules.PY_MODULE_MUTABLE if is_py else rules.JS_MODULE_MUTABLE
    findings = []
    for number, raw in enumerate(lines, start=1):
        # Module scope == column 0 (unindented). A mutable declared inside a
        # function is local and cannot leak between tests.
        if raw[:1].isspace():
            continue
        match = decl_re.match(raw.strip())
        if not match:
            continue
        name = match.group(1)
        if rules.mutation_pattern(name).search(text):
            findings.append(_make(file, number, "SV001-module-mutable-global", raw.strip()))
    return findings


def _sv002_missing_teardown(lines: list, file: str, is_py: bool, text: str) -> list:
    """Setup markers whose matching teardown is absent from the file."""
    pairs = rules.PYTHON_SETUP_TEARDOWN if is_py else rules.JS_SETUP_TEARDOWN
    findings = []
    for setup, teardown in pairs:
        if teardown in text:
            continue
        for number, raw in enumerate(lines, start=1):
            stripped = raw.strip()
            if _is_comment(stripped):
                continue
            hit = (
                f"def {setup}" in stripped if is_py
                else stripped.startswith(f"{setup}(") or f" {setup}(" in stripped
            )
            if hit:
                findings.append(_make(file, number, "SV002-missing-teardown", stripped))
                break  # one finding per unmatched setup marker
    return findings


def scan_text(text: str, file: str = "<text>") -> list:
    """Scan source text, returning findings ordered by line then rule id."""
    is_py = file.endswith(".py")
    lines = text.splitlines()
    findings: list = []

    findings.extend(_sv001_module_mutables(lines, file, is_py, text))
    findings.extend(_sv002_missing_teardown(lines, file, is_py, text))

    for number, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if not stripped:
            continue
        # SV004 is self-reported ordering: it fires on comments and code alike.
        if rules.SV004_PATTERN.search(stripped):
            findings.append(_make(file, number, "SV004-order-coupled-name", stripped))
        if _is_comment(stripped):
            continue
        if rules.SV003_PATTERN.search(stripped):
            findings.append(_make(file, number, "SV003-shared-singleton-mutation", stripped))

    findings.sort(key=lambda f: (f.line, f.rule_id))
    return findings


def scan_file(path: Path) -> list:
    """Scan one file. Unreadable or non-UTF-8 files yield no findings."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return scan_text(text, str(path))


def _iter_files(root: Path):
    """Yield the files a path contributes: explicit files win, dirs are filtered."""
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
