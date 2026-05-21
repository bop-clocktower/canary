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
