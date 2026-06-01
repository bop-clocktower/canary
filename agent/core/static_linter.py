"""Static linter for test files.

Produces file:line findings without executing tests or calling an LLM.
Powers `canary review-test --static` (full quality audit) and
`canary flake-check` (flakiness-only subset).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


# ---------------------------------------------------------------------------
# Finding
# ---------------------------------------------------------------------------

@dataclass
class Finding:
    file: str
    line: int
    rule: str
    severity: str  # "critical" | "warning" | "info"
    message: str
    suggestion: str

    def __str__(self) -> str:
        return f"[{self.severity.upper()}] {self.file}:{self.line} ({self.rule})\n  {self.message}\n  → {self.suggestion}"


# ---------------------------------------------------------------------------
# Rule patterns
# ---------------------------------------------------------------------------

# Flakiness
_SLEEP = re.compile(r"time\.sleep\s*\(|page\.waitForTimeout\s*\(")
_SETTIMEOUT = re.compile(r"(?<!\w)setTimeout\s*\(")
_RANDOM = re.compile(r"Math\.random\s*\(|random\.random\s*\(|random\.choice\s*\(|random\.randint\s*\(")
_TIMESTAMP = re.compile(r"Date\.now\s*\(|datetime\.now\s*\(|datetime\.utcnow\s*\(")

# Brittle selectors (CSS class / id / xpath)
_CSS_CLASS_SELECTOR = re.compile(r"""['"]\.[a-zA-Z][\w\-]*['"]""")
_CSS_ID_SELECTOR = re.compile(r"""['"]#[a-zA-Z][\w\-]*['"]""")
_XPATH_SELECTOR = re.compile(r"""['"]/+[a-zA-Z\[\]/@*]""")
_LOCATOR_METHODS = re.compile(r"\.(locator|querySelector)\s*\(")

# Missing await — bare Playwright locator chains not preceded by await
_BARE_PLAYWRIGHT_CALL = re.compile(
    r"(?<!await\s)(?<!return\s)(?<!\w)"
    r"(?:page|frame|locator)\."
    r"(?:click|fill|type|check|uncheck|selectOption|hover|focus|press|tap|dblclick)\s*\("
)

# Test functions per framework (to detect assertion-free tests)
_TEST_FN_PY = re.compile(r"^(\s*)def (test_\w+)\s*\(", re.MULTILINE)
_TEST_FN_JS = re.compile(r"(?:^|\s)(?:it|test)\s*\(\s*['\"]([^'\"]*)['\"]", re.MULTILINE)

_ASSERT_PY = re.compile(r"\bassert\b|\bpytest\.raises\b")
_ASSERT_JS = re.compile(r"\bexpect\s*\(|\bto(?:Be|Equal|Contain|Have|Match|Throw|Raise)\b")

# String/comment strippers
_STRING_LITERAL = re.compile(r"""(['"])(?:\\.|(?!\1).)*?\1""")
_PY_COMMENT = re.compile(r"#.*$", re.MULTILINE)
_JS_COMMENT = re.compile(r"//.*$", re.MULTILINE)

# Magic numbers (reused from quality_scorer logic)
_NUMERIC_LITERAL = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])")
_ALLOWED_NUMBERS = {"0", "1", "2", "-1", "10", "100"}
_HTTP_STATUS = {
    "200", "201", "202", "204", "301", "302", "304",
    "400", "401", "403", "404", "405", "409", "410", "422", "429",
    "500", "501", "502", "503", "504",
}


def _is_allowed_number(token: str) -> bool:
    if token in _ALLOWED_NUMBERS or token in _HTTP_STATUS:
        return True
    bare = token.lstrip("-")
    return bare.isdigit() and len(bare) == 1


def _is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("*")


# ---------------------------------------------------------------------------
# Per-line scanners
# ---------------------------------------------------------------------------

def _scan_flakiness(lines: List[str], filepath: str) -> List[Finding]:
    findings: List[Finding] = []
    for i, line in enumerate(lines, 1):
        if _is_comment(line):
            continue
        if _SLEEP.search(line):
            findings.append(Finding(
                file=filepath, line=i, rule="FLAKE-001", severity="critical",
                message="Hardcoded sleep/wait detected.",
                suggestion="Replace with an event-based wait (e.g. expect(locator).toBeVisible(), page.waitForResponse(), waitFor()).",
            ))
        if _SETTIMEOUT.search(line) and "waitFor" not in line:
            findings.append(Finding(
                file=filepath, line=i, rule="FLAKE-002", severity="critical",
                message="setTimeout used without a corresponding waitFor.",
                suggestion="Wrap in page.waitForFunction() or replace with an awaitable assertion.",
            ))
        if _RANDOM.search(line):
            findings.append(Finding(
                file=filepath, line=i, rule="FLAKE-003", severity="warning",
                message="Non-deterministic random value in test.",
                suggestion="Use a fixed seed or a static fixture value instead.",
            ))
        if _TIMESTAMP.search(line):
            findings.append(Finding(
                file=filepath, line=i, rule="FLAKE-004", severity="warning",
                message="Timestamp-dependent value detected.",
                suggestion="Mock Date.now()/datetime.now() or use a fixed reference date.",
            ))
    return findings


def _scan_selectors(lines: List[str], filepath: str) -> List[Finding]:
    findings: List[Finding] = []
    for i, line in enumerate(lines, 1):
        if _is_comment(line):
            continue
        if _LOCATOR_METHODS.search(line):
            if _CSS_CLASS_SELECTOR.search(line):
                findings.append(Finding(
                    file=filepath, line=i, rule="LINT-001", severity="warning",
                    message="CSS class selector is brittle.",
                    suggestion="Prefer getByRole(), getByLabel(), or data-testid attributes.",
                ))
            elif _CSS_ID_SELECTOR.search(line):
                findings.append(Finding(
                    file=filepath, line=i, rule="LINT-002", severity="warning",
                    message="CSS id selector may break if the id changes.",
                    suggestion="Prefer getByTestId() or getByRole() over id-based selectors.",
                ))
            elif _XPATH_SELECTOR.search(line):
                findings.append(Finding(
                    file=filepath, line=i, rule="LINT-003", severity="warning",
                    message="XPath selector is fragile.",
                    suggestion="Replace with role, label, or test-id based locators.",
                ))
    return findings


def _scan_missing_await(lines: List[str], filepath: str) -> List[Finding]:
    findings: List[Finding] = []
    for i, line in enumerate(lines, 1):
        if _is_comment(line):
            continue
        if _BARE_PLAYWRIGHT_CALL.search(line) and "await" not in line:
            findings.append(Finding(
                file=filepath, line=i, rule="LINT-004", severity="critical",
                message="Playwright action called without await.",
                suggestion="Add `await` before the call to ensure it completes before the next step.",
            ))
    return findings


def _scan_magic_numbers(lines: List[str], filepath: str) -> List[Finding]:
    findings: List[Finding] = []
    for i, raw in enumerate(lines, 1):
        if _is_comment(raw):
            continue
        scrubbed = _STRING_LITERAL.sub('""', raw)
        for m in _NUMERIC_LITERAL.finditer(scrubbed):
            token = m.group()
            if _is_allowed_number(token):
                continue
            findings.append(Finding(
                file=filepath, line=i, rule="LINT-005", severity="info",
                message=f"Magic number {token}.",
                suggestion="Extract to a named constant or derive from test data.",
            ))
            break  # one finding per line to avoid flooding
    return findings


def _scan_assertion_free_tests(code: str, filepath: str, framework: str) -> List[Finding]:
    """Detect test functions that contain no assertions."""
    findings: List[Finding] = []

    if framework in ("pytest",):
        for m in _TEST_FN_PY.finditer(code):
            fn_name = m.group(2)
            fn_start = m.start()
            # Grab the body: from match end to next same-indent def or EOF
            indent = len(m.group(1))
            rest = code[m.end():]
            next_fn = re.search(rf"^[ \t]{{{indent}}}def ", rest, re.MULTILINE)
            body = rest[: next_fn.start()] if next_fn else rest
            if not _ASSERT_PY.search(body):
                line_no = code[:fn_start].count("\n") + 1
                findings.append(Finding(
                    file=filepath, line=line_no, rule="LINT-006", severity="warning",
                    message=f"`{fn_name}` contains no assertions.",
                    suggestion="Add at least one assert statement; a test that never fails proves nothing.",
                ))
    else:
        for m in _TEST_FN_JS.finditer(code):
            fn_name = m.group(1)
            fn_start = m.start()
            # Grab a window of ~50 lines after the test declaration
            rest = code[m.end(): m.end() + 2000]
            if not _ASSERT_JS.search(rest):
                line_no = code[:fn_start].count("\n") + 1
                findings.append(Finding(
                    file=filepath, line=line_no, rule="LINT-006", severity="warning",
                    message=f'Test "{fn_name}" contains no assertions.',
                    suggestion="Add an expect() call; a test that never asserts always passes.",
                ))
    return findings


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _detect_framework(path: Path) -> str:
    suffix = path.suffix.lower()
    name = path.name.lower()
    if suffix == ".py":
        return "pytest"
    if "playwright" in name or suffix in (".spec.ts", ".spec.js"):
        return "playwright"
    if suffix in (".ts", ".js"):
        return "vitest"
    return "pytest"


class StaticLinter:
    """Purely static test-file linter. No LLM, no test execution."""

    def lint(self, path: Path, framework: Optional[str] = None) -> List[Finding]:
        """Full quality audit — all rules."""
        code = path.read_text(encoding="utf-8")
        lines = code.splitlines()
        fw = framework or _detect_framework(path)
        filepath = str(path)

        findings: List[Finding] = []
        findings += _scan_flakiness(lines, filepath)
        findings += _scan_selectors(lines, filepath)
        findings += _scan_missing_await(lines, filepath)
        findings += _scan_magic_numbers(lines, filepath)
        findings += _scan_assertion_free_tests(code, filepath, fw)
        findings.sort(key=lambda f: (f.line, f.rule))
        return findings

    def flake_check(self, path: Path) -> List[Finding]:
        """Flakiness-only subset — the patterns most likely to cause intermittent CI failures."""
        code = path.read_text(encoding="utf-8")
        lines = code.splitlines()
        filepath = str(path)

        findings = _scan_flakiness(lines, filepath)
        findings.sort(key=lambda f: f.line)
        return findings
