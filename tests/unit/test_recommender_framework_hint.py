"""FrameworkRecommender accepts a framework_hint to break ties when two
frameworks claim the same test_type and project metadata doesn't narrow.

Before this, an ``api`` classification with no metadata fell back to whichever
framework appeared first in the registry — pytest mentions in a JS-leaning
prompt landed on Playwright anyway. The hint kwarg lets the prompt's explicit
framework name override the registry default within the language-filtered set.
"""

import unittest

from agent.core.classifier import ClassificationResult
from agent.core.recommender import FrameworkRecommender


def _api(test_type="api"):
    return ClassificationResult(intent="generate_tests", test_type=test_type, confidence=1.0)


class TestFrameworkHint(unittest.TestCase):

    def setUp(self):
        self.rec = FrameworkRecommender()

    def test_pytest_hint_wins_api_without_metadata(self):
        result = self.rec.recommend(_api("api"), metadata=None, framework_hint="pytest")
        self.assertEqual(result["framework"], "pytest")
        self.assertTrue(
            any("prompt-named framework (pytest)" in r for r in result["reason"]),
            f"reason list missing hint marker: {result['reason']!r}",
        )

    def test_playwright_hint_wins_api_without_metadata(self):
        result = self.rec.recommend(_api("api"), metadata=None, framework_hint="playwright")
        self.assertEqual(result["framework"], "playwright")

    def test_hint_ignored_when_not_in_candidates(self):
        """A hint for a framework that doesn't satisfy the test_type is
        silently dropped — caller still gets a valid recommendation."""
        result = self.rec.recommend(
            _api("performance"), metadata=None, framework_hint="pytest"
        )
        self.assertEqual(result["framework"], "k6")
        self.assertFalse(
            any("prompt-named framework" in r for r in result["reason"]),
            f"hint marker leaked when hint was dropped: {result['reason']!r}",
        )

    def test_no_hint_preserves_existing_default(self):
        """Sanity: without a hint the recommender behaves exactly as before."""
        result = self.rec.recommend(_api("e2e_ui"), metadata=None)
        self.assertEqual(result["framework"], "playwright")


if __name__ == "__main__":
    unittest.main()
