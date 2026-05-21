"""Test quality static analyser.

Scores Oracle-generated test files on three dimensions:
  - coverage_breadth:  number of test cases + negative/error path coverage
  - assertion_density: assertions per test function
  - flakiness_risk:    absence of hardcoded waits, random values, timestamp deps

All analysis is purely lexical — no execution required.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Regex dispatch tables
# ---------------------------------------------------------------------------

# Patterns that identify individual test cases per framework
_TEST_FN: Dict[str, re.Pattern] = {
    "pytest":     re.compile(r"^\s*def test_", re.MULTILINE),
    "playwright": re.compile(r"\btest\s*\(", re.MULTILINE),
    "vitest":     re.compile(r"\b(?:it|test)\s*\(", re.MULTILINE),
    "k6":         re.compile(r"\bcheck\s*\(", re.MULTILINE),
}

# Patterns that identify assertions per framework
_ASSERTIONS: Dict[str, re.Pattern] = {
    "pytest": re.compile(
        r"\bassert\b|\bpytest\.raises\b|\bself\.assert\w+\b"
    ),
    "playwright": re.compile(
        r"\bexpect\s*\(|\btoBeVisible\b|\btoHaveText\b"
        r"|\btoHaveTitle\b|\btoHaveURL\b|\btoBeEnabled\b|\btoBeDisabled\b"
        r"|\btoBeChecked\b|\btoHaveValue\b|\btoHaveCount\b"
    ),
    "vitest": re.compile(
        r"\bexpect\s*\(|\btoBe\s*\(|\btoEqual\s*\(|\btoThrow\b"
        r"|\btoContain\s*\(|\btoBeNull\b|\btoBeUndefined\b|\btoMatchObject\b"
    ),
    "k6": re.compile(
        r"\bcheck\s*\(|'[^']+'\s*:\s*\([^)]*\)\s*=>"
    ),
}

# Keywords that signal negative / error path coverage
_NEGATIVE_KW = re.compile(
    r"\b(error|invalid|empty|null|undefined|throws|raises|exception"
    r"|fail|missing|negative|reject|4\d{2}|5\d{2}|boundary|edge)\b",
    re.IGNORECASE,
)

# Parametrized test patterns
_PARAMETRIZE = re.compile(
    r"@pytest\.mark\.parametrize|test\.each\s*\(|describe\.each\s*\(|it\.each\s*\("
)

# Flakiness signals
_SLEEP = re.compile(
    r"time\.sleep\s*\(|page\.waitForTimeout\s*\("
    r"|await\s+new\s+Promise[^)]*setTimeout|setTimeout\s*\("
)
_RANDOM = re.compile(
    r"Math\.random\s*\(|random\.random\s*\(|random\.choice\s*\(|random\.randint\s*\("
)
_TIMESTAMP = re.compile(
    r"Date\.now\s*\(|datetime\.now\s*\(|datetime\.utcnow\s*\("
)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class QualityScore:
    score: int
    grade: str
    coverage_breadth: int
    assertion_density: int
    flakiness_risk: int
    details: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "grade": self.grade,
            "coverage_breadth": self.coverage_breadth,
            "assertion_density": self.assertion_density,
            "flakiness_risk": self.flakiness_risk,
            "details": self.details,
        }


# ---------------------------------------------------------------------------
# Dimension scorers
# ---------------------------------------------------------------------------

def _score_coverage(code: str, framework: str) -> Tuple[int, List[str]]:
    details: List[str] = []
    pattern = _TEST_FN.get(framework, _TEST_FN["pytest"])
    count = len(pattern.findall(code))

    label = "check" if framework == "k6" else "test function"
    plural = "s" if count != 1 else ""
    details.append(f"{count} {label}{plural} found")

    # Base from test count
    base = min(90, [0, 25, 45, 65, 80, 90][min(count, 5)])

    bonus = 0
    if _NEGATIVE_KW.search(code):
        bonus += 10
        details.append("Covers error/invalid paths")
    if _PARAMETRIZE.search(code):
        bonus += 10
        details.append("Parametrized test cases detected")

    return min(100, base + bonus), details


def _score_assertions(code: str, framework: str) -> Tuple[int, List[str]]:
    details: List[str] = []
    fn_pat = _TEST_FN.get(framework, _TEST_FN["pytest"])
    assert_pat = _ASSERTIONS.get(framework, _ASSERTIONS["pytest"])

    test_count = max(1, len(fn_pat.findall(code)))
    assert_count = len(assert_pat.findall(code))
    density = assert_count / test_count

    plural = "s" if assert_count != 1 else ""
    details.append(f"{assert_count} assertion{plural}, {density:.1f} per test")

    if density == 0:
        score = 0
    elif density < 1:
        score = 25
    elif density < 2:
        score = 55
    elif density < 3:
        score = 75
    elif density < 4:
        score = 88
    else:
        score = 97

    return score, details


def _score_flakiness(code: str) -> Tuple[int, List[str]]:
    details: List[str] = []
    score = 100

    sleep_n = len(_SLEEP.findall(code))
    if sleep_n:
        deduction = min(40, sleep_n * 20)
        score -= deduction
        plural = "s" if sleep_n != 1 else ""
        details.append(f"{sleep_n} hardcoded wait{plural} detected")

    if _RANDOM.search(code):
        score -= 15
        details.append("Non-deterministic random values detected")

    if _TIMESTAMP.search(code):
        score -= 10
        details.append("Timestamp-dependent assertions detected")

    if not details:
        details.append("No flakiness signals detected")

    return max(0, score), details


def _grade(score: int) -> str:
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 55:
        return "C"
    if score >= 40:
        return "D"
    return "F"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class QualityScorer:
    """Scores Oracle-generated test files via static analysis."""

    def score(self, source: "str | Path", framework: str) -> dict:
        """Return a quality score dict for `source` (code string or file path)."""
        code = Path(source).read_text(encoding="utf-8") if isinstance(source, Path) else source
        fw = framework.lower()

        coverage, cov_details = _score_coverage(code, fw)
        assertion, asr_details = _score_assertions(code, fw)
        flakiness, flk_details = _score_flakiness(code)

        composite = round(0.4 * coverage + 0.4 * assertion + 0.2 * flakiness)

        return QualityScore(
            score=composite,
            grade=_grade(composite),
            coverage_breadth=coverage,
            assertion_density=assertion,
            flakiness_risk=flakiness,
            details=cov_details + asr_details + flk_details,
        ).to_dict()
