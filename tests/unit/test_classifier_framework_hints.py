"""Explicit framework names in the prompt outrank URL/keyword heuristics.

Without this, prompts like "Generate a Playwright test for https://example.com/login"
or "Generate a Vitest unit test for validateEmail" misclassify — the URL/keyword
heuristics dominate the user's explicit framework choice.
"""

import unittest
from agent.core.classifier import TestClassifier, extract_framework_hint


class TestFrameworkHints(unittest.TestCase):

    def setUp(self):
        self.clf = TestClassifier()

    # --- shipped example prompts (downstream regression set) ---

    def test_playwright_example_classifies_e2e(self):
        prompt = (
            "Generate a Playwright test for a login page at "
            "https://example.com/login."
        )
        self.assertEqual(self.clf.classify(prompt).test_type, "e2e_ui")

    def test_pytest_example_classifies_api(self):
        prompt = "Generate a Pytest test file for POST https://api.example.com/v1/checkout."
        self.assertEqual(self.clf.classify(prompt).test_type, "api")

    def test_vitest_example_classifies_frontend_unit(self):
        prompt = (
            "Generate a Vitest unit test for a function "
            "validateEmail(input: string)."
        )
        self.assertEqual(self.clf.classify(prompt).test_type, "frontend_unit")

    def test_k6_example_classifies_performance(self):
        prompt = "Generate a k6 load test for POST https://api.example.com/v1/checkout."
        self.assertEqual(self.clf.classify(prompt).test_type, "performance")

    def test_lego_tracker_example_classifies_api(self):
        """reconcile_collection is a pure dict function — no HTTP verb or UI keyword,
        so it falls through to the api bucket (the classifier's home for structured
        data functions that aren't obviously E2E or frontend)."""
        prompt = (
            "Generate pytest unit tests for a reconcile_collection function "
            "that diffs locally-tracked LEGO set IDs against Rebrickable API sets."
        )
        self.assertEqual(self.clf.classify(prompt).test_type, "api")

    # --- each hint maps to its declared test_type ---

    def test_playwright_hint_maps_to_e2e_ui(self):
        self.assertEqual(
            self.clf.classify("Use Playwright to test the checkout flow").test_type,
            "e2e_ui",
        )

    def test_cypress_hint_maps_to_e2e_ui(self):
        self.assertEqual(
            self.clf.classify("Use Cypress to test the checkout flow").test_type,
            "e2e_ui",
        )

    def test_vitest_hint_maps_to_frontend_unit(self):
        self.assertEqual(
            self.clf.classify("Use Vitest to test the parser").test_type,
            "frontend_unit",
        )

    def test_jest_hint_maps_to_frontend_unit(self):
        self.assertEqual(
            self.clf.classify("Use Jest to test the parser").test_type,
            "frontend_unit",
        )

    def test_pytest_hint_maps_to_api(self):
        self.assertEqual(
            self.clf.classify("write a pytest suite for the orders endpoint").test_type,
            "api",
        )

    def test_k6_hint_maps_to_performance(self):
        self.assertEqual(
            self.clf.classify("Use k6 to test the checkout endpoint").test_type,
            "performance",
        )

    # --- precedence rules ---

    def test_framework_hint_outranks_http_path(self):
        """A Playwright hint must win even when an HTTP verb+path would
        otherwise route the prompt to api."""
        prompt = "Playwright test that POST /api/orders/{id} renders the receipt page"
        self.assertEqual(self.clf.classify(prompt).test_type, "e2e_ui")

    def test_performance_keyword_still_wins_over_hint(self):
        """'load test' is a stronger intent than a framework name —
        performance runs first, so this stays performance even with
        "Playwright" in the same prompt."""
        prompt = "Run a load test using Playwright Test Runner"
        self.assertEqual(self.clf.classify(prompt).test_type, "performance")

    # --- hint is case-insensitive but word-boundary-bound ---

    def test_hint_is_case_insensitive(self):
        for variant in ("playwright", "Playwright", "PLAYWRIGHT", "PlAyWrIgHt"):
            with self.subTest(variant=variant):
                self.assertEqual(
                    self.clf.classify(f"Use {variant} to test the checkout flow").test_type,
                    "e2e_ui",
                )

    def test_substring_does_not_match(self):
        """'apicurio' contains 'api' but should not match a framework hint —
        word boundaries protect against substring false positives."""
        result = extract_framework_hint("apicurio is not a framework")
        self.assertIsNone(result)


class TestExtractFrameworkHint(unittest.TestCase):

    def test_returns_lowercased_match(self):
        self.assertEqual(extract_framework_hint("Use Playwright"), "playwright")

    def test_returns_none_when_no_hint(self):
        self.assertIsNone(extract_framework_hint("plain prompt with no framework named"))

    def test_first_match_wins(self):
        """If multiple framework names appear, the first by position wins."""
        self.assertEqual(
            extract_framework_hint("compare Playwright and Cypress"),
            "playwright",
        )


if __name__ == "__main__":
    unittest.main()
