"""Stage 1 — 16-category expansion.

Two contracts locked here:
1. Each new specialized-category keyword classifies to its category.
2. Every classifier test_type resolves to a non-null framework in the
   registry (the classifier<->registry contract).
"""

import unittest

from agent.core.classifier import TestClassifier, _CATEGORY_KEYWORDS
from agent.core.framework_registry import FrameworkRegistry


class TestStage1Classification(unittest.TestCase):
    def setUp(self):
        self.clf = TestClassifier()

    def test_each_new_category_keyword_classifies(self):
        cases = {
            "run an accessibility audit on the dashboard": "accessibility",
            "we need a penetration test of the login API": "security",
            "add visual regression coverage for the header": "visual",
            "set up consumer-driven contract testing between services": "contract",
            "chaos engineering experiment for the payment service": "chaos",
            "generate synthetic data for the orders fixture": "synthetic_data",
            "assert the distributed tracing spans are emitted": "observability",
            "write a mobile test for the android checkout": "mobile",
            "measure our mutation score on the parser": "mutation",
            "add a static analysis rule for unsafe calls": "static_analysis",
            "soak test the search endpoint with concurrent users": "load",
            "integration test the service against a real database": "integration",
        }
        for prompt, expected in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(self.clf.classify(prompt).test_type, expected)

    def test_load_test_phrase_still_routes_to_performance(self):
        # Guard the ordering: "load test" must stay performance, not load.
        self.assertEqual(
            self.clf.classify("load test the checkout endpoint").test_type,
            "performance",
        )


class TestClassifierRegistryContract(unittest.TestCase):
    """Every test_type the classifier can emit must resolve to a framework."""

    def test_every_category_resolves_to_a_framework(self):
        registry = FrameworkRegistry()
        # The full set of test_types the classifier can return.
        category_types = {t for t, _ in _CATEGORY_KEYWORDS}
        legacy_types = {"e2e_ui", "api", "frontend_unit", "performance"}
        for test_type in category_types | legacy_types:
            with self.subTest(test_type=test_type):
                frameworks = registry.get_by_category(test_type)
                self.assertTrue(
                    frameworks,
                    f"no framework resolves for test_type {test_type!r}",
                )


if __name__ == "__main__":
    unittest.main()
