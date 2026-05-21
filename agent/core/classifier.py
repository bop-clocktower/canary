# agent/core/classifier.py

"""
Test Classifier - Identifies the intent and test type from user prompts.

This module provides rule-based classification to determine whether a user
wants to generate E2E, API, Performance, or Unit tests.
"""

import re
from dataclasses import dataclass

# HTTP verb + slash-prefixed path: "GET /users", "POST /items/{id}"
_HTTP_VERB_PATH_RE = re.compile(
    r"\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/",
    re.IGNORECASE,
)

# Bare HTTP verb with no explicit path (case-sensitive — requires uppercase so
# common English words like "get"/"delete"/"post" don't trigger false positives).
_HTTP_VERB_RE = re.compile(
    r"\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b",
)

# Maps an explicit framework name in the prompt to the test_type it implies.
# A user who writes "Playwright" or "Vitest" by name is giving us a stronger
# signal than any URL or keyword heuristic — honor it before the API/UI
# fallthrough. "load test"/"stress test" still wins (performance is checked
# first) so "load test with Playwright runner" stays performance.
_FRAMEWORK_HINTS = {
    "playwright": "e2e_ui",
    "cypress": "e2e_ui",
    "vitest": "frontend_unit",
    "jest": "frontend_unit",
    "pytest": "api",
    "k6": "performance",
}
_FRAMEWORK_HINT_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in _FRAMEWORK_HINTS) + r")\b",
    re.IGNORECASE,
)


def extract_framework_hint(prompt: str) -> "str | None":
    """Return the lowercase framework name explicitly mentioned in the prompt, if any."""
    m = _FRAMEWORK_HINT_RE.search(prompt)
    return m.group(1).lower() if m else None


@dataclass
class ClassificationResult:
    """
    Data container for the result of a classification task.

    Attributes:
        intent: The high-level intent (e.g., 'generate_tests').
        test_type: The specific category of test (e.g., 'performance').
        confidence: The probability score (0.0 to 1.0) of the classification.
    """
    intent: str
    test_type: str
    confidence: float


class TestClassifier:
    """
    Heuristic-based classifier for natural language requirements.
    """

    def classify(self, prompt: str) -> ClassificationResult:
        """
        Analyzes a prompt to determine the intended test type.

        Args:
            prompt: The natural language requirement string.

        Returns:
            ClassificationResult: The identified category and confidence.
        """
        p = prompt.lower()

        # --- PERFORMANCE ---  (checked before HTTP signals — "load test GET /x" is perf)
        if "performance" in p or "load test" in p or "stress test" in p:
            return ClassificationResult(
                intent="generate_tests",
                test_type="performance",
                confidence=0.95
            )

        # --- EXPLICIT FRAMEWORK HINT ---
        # A named framework in the prompt outranks URL/keyword heuristics —
        # otherwise "Playwright test for /api/orders/{id}" gets routed to api
        # by the HTTP-path match, and "Vitest unit test for validateEmail"
        # falls through to the e2e_ui default.
        hint = _FRAMEWORK_HINT_RE.search(prompt)
        if hint:
            return ClassificationResult(
                intent="generate_tests",
                test_type=_FRAMEWORK_HINTS[hint.group(1).lower()],
                confidence=0.95,
            )

        # --- HTTP VERB / PATH SIGNALS ---
        if _HTTP_VERB_PATH_RE.search(prompt):
            return ClassificationResult(
                intent="generate_tests",
                test_type="api",
                confidence=0.95,
            )
        if _HTTP_VERB_RE.search(prompt):
            return ClassificationResult(
                intent="generate_tests",
                test_type="api",
                confidence=0.85,
            )

        # --- API TESTING ---
        if "api" in p or "endpoint" in p or "request" in p:
            return ClassificationResult(
                intent="generate_tests",
                test_type="api",
                confidence=0.85
            )

        # --- FRONTEND UNIT / COMPONENT ---
        if "component" in p or "react" in p or "frontend" in p:
            return ClassificationResult(
                intent="generate_tests",
                test_type="frontend_unit",
                confidence=0.9
            )

        # --- DEFAULT E2E ---
        if "login" in p or "checkout" in p or "user flow" in p:
            return ClassificationResult(
                intent="generate_tests",
                test_type="e2e_ui",
                confidence=0.8
            )

        # fallback
        return ClassificationResult(
            intent="generate_tests",
            test_type="e2e_ui",
            confidence=0.5
        )
