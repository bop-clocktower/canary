# agent/core/classifier.py

"""
Test Classifier - Identifies the intent and test type from user prompts.

This module provides rule-based classification to determine whether a user
wants to generate E2E, API, Performance, or Unit tests.

CONFIDENCE VALUES ARE NOT CALIBRATED PROBABILITIES.
The 0.5-0.95 confidence numbers attached to each keyword-match branch below
are hand-picked heuristic priors, not statistical probabilities computed
from labeled data. There is no calibration model behind them — a 0.95 was
chosen by a human because that branch's signal (e.g. an explicit framework
name or HTTP-verb-plus-path match) felt strong, and a 0.5 because the
fallback branch felt weak. Building real calibration would require a
labeled dataset of prompts and outcomes that does not exist yet; this
docstring is a docs-only stopgap so a caller (including CI automation)
does not over-trust the ordering of two confidence values as if they were
drawn from a calibrated probability distribution. Treat `confidence` as a
coarse, ordinal "how strong did this heuristic's signal look" rank, not as
P(correct classification).
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
    "hurl": "api",
    "k6": "performance",
    # Stage 1 — specialized-category tools. A named tool is a strong signal
    # for its category even when the prompt is otherwise generic.
    "axe": "accessibility",
    "axe-core": "accessibility",
    "pa11y": "accessibility",
    "zap": "security",
    "backstopjs": "visual",
    "percy": "visual",
    "pact": "contract",
    "schemathesis": "contract",
    "chaos-toolkit": "chaos",
    "faker": "synthetic_data",
    "sdv": "synthetic_data",
    "opentelemetry": "observability",
    "maestro": "mobile",
    "appium": "mobile",
    "wdio": "mobile",
    "webdriverio": "mobile",
    "locust": "load",
    "gatling": "load",
    "stryker": "mutation",
    "mutmut": "mutation",
    "semgrep": "static_analysis",
    "testcontainers": "integration",
    # Tier-1 categories (issue #335): property-based + LLM-eval tools.
    "fast-check": "property",
    "fastcheck": "property",
    "hypothesis": "property",
    "promptfoo": "llm_eval",
}

# Stage 1 — specialized test categories keyed by high-specificity phrases.
# Checked after the performance rule (so "load test" stays performance) and
# before the generic HTTP/api/ui fallbacks. Keywords are deliberately narrow
# so they don't steal generic prompts; first match wins, so more specific
# phrases are listed where overlap is possible.
_CATEGORY_KEYWORDS = (
    ("accessibility", ("accessibility", "a11y", "wcag", "screen reader")),
    ("security", ("security test", "pentest", "penetration test",
                  "vulnerability scan", "owasp", "dast", "sast")),
    ("visual", ("visual regression", "visual test", "screenshot test",
                "snapshot test", "pixel diff")),
    ("contract", ("contract test", "consumer-driven contract", "pact test",
                  "openapi contract", "schema contract")),
    ("chaos", ("chaos engineering", "chaos test", "fault injection",
               "resilience test")),
    ("synthetic_data", ("synthetic data", "fake data", "test data generation",
                        "data generation")),
    ("observability", ("observability", "telemetry", "distributed tracing",
                       "instrumentation test")),
    ("mobile", ("mobile test", "android test", "ios test", "react native test",
                "mobile app test")),
    ("mutation", ("mutation test", "mutation testing", "mutation score")),
    ("static_analysis", ("static analysis", "lint rule", "code smell",
                         "sonarqube")),
    ("load", ("soak test", "spike test", "concurrent users", "load profile")),
    ("integration", ("integration test", "integration testing",
                     "end-to-end integration")),
    # Tier-1 categories (issue #335).
    ("property", ("property-based", "property based", "property test",
                  "invariant test", "quickcheck", "generative test")),
    ("llm_eval", ("llm eval", "llm evaluation", "prompt regression",
                  "prompt eval", "llm behavior", "llm regression")),
)
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
        confidence: A heuristic prior in [0.0, 1.0], NOT a calibrated
            probability. Each classify() branch has a hardcoded confidence
            value hand-picked by the branch's author based on how strong
            its keyword/regex signal looked; none of it is derived from
            statistical calibration against labeled outcomes. Use it as a
            coarse, ordinal ranking of signal strength — do not treat the
            gap between e.g. 0.95 and 0.55 as a meaningful probability
            delta, and do not gate CI decisions on an absolute threshold
            without accounting for this.
    """
    intent: str
    test_type: str
    confidence: float


class TestClassifier:
    """
    Heuristic-based classifier for natural language requirements.

    Every ClassificationResult.confidence this class returns is a
    hand-calibrated heuristic prior, not a statistical probability — see
    the module docstring for the full disclosure. In short: these scores
    were assigned by a human judging signal strength per branch, not
    computed from data, so don't over-trust a 0.95 vs. a 0.55 as if they
    were calibrated.
    """

    def classify(self, prompt: str) -> ClassificationResult:
        """
        Analyzes a prompt to determine the intended test type.

        Args:
            prompt: The natural language requirement string.

        Returns:
            ClassificationResult: The identified category and confidence.
        """
        prompt_lower = prompt.lower()

        # --- PERFORMANCE ---  (checked before HTTP signals — "load test GET /x" is perf)
        if "performance" in prompt_lower or "load test" in prompt_lower or "stress test" in prompt_lower:
            return ClassificationResult(
                intent="generate_tests",
                test_type="performance",
                confidence=0.95
            )

        # --- SPECIALIZED CATEGORIES (Stage 1) ---
        # High-specificity intents checked before the framework-hint and
        # generic HTTP/api/ui rules. "load test" already returned above as
        # performance, so the load category here only fires on distinct
        # phrasing (soak/spike/concurrent users).
        for test_type, keywords in _CATEGORY_KEYWORDS:
            if any(kw in prompt_lower for kw in keywords):
                return ClassificationResult(
                    intent="generate_tests",
                    test_type=test_type,
                    confidence=0.88,
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
        if "api" in prompt_lower or "endpoint" in prompt_lower or "request" in prompt_lower:
            return ClassificationResult(
                intent="generate_tests",
                test_type="api",
                confidence=0.85
            )

        # --- FRONTEND UNIT / COMPONENT ---
        if "component" in prompt_lower or "react" in prompt_lower or "frontend" in prompt_lower:
            return ClassificationResult(
                intent="generate_tests",
                test_type="frontend_unit",
                confidence=0.9
            )

        # --- DEFAULT E2E ---
        if "login" in prompt_lower or "checkout" in prompt_lower or "user flow" in prompt_lower:
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
