"""Stage 1 — recommend() returns a ranked candidate list with confidence."""

import unittest

from agent.core.classifier import ClassificationResult
from agent.core.recommender import FrameworkRecommender


def _cls(test_type: str, confidence: float = 0.9) -> ClassificationResult:
    return ClassificationResult(
        intent="generate_tests", test_type=test_type, confidence=confidence
    )


class TestRankedRecommendation(unittest.TestCase):
    def setUp(self):
        self.rec = FrameworkRecommender()

    def test_returns_a_list(self):
        result = self.rec.recommend(_cls("e2e_ui"))
        self.assertIsInstance(result, list)
        self.assertGreaterEqual(len(result), 1)

    def test_capped_at_three(self):
        # api resolves to multiple frameworks; the list never exceeds 3.
        result = self.rec.recommend(_cls("api"))
        self.assertLessEqual(len(result), 3)

    def test_confidence_echoed_on_each_candidate(self):
        result = self.rec.recommend(_cls("api", confidence=0.85))
        self.assertTrue(result)
        for entry in result:
            self.assertEqual(entry["confidence"], 0.85)

    def test_hinted_framework_ranked_first(self):
        # api has more than one candidate; the hint should top the ranking.
        result = self.rec.recommend(
            _cls("api"), metadata=None, framework_hint="pytest"
        )
        self.assertEqual(result[0]["framework"], "pytest")
        self.assertTrue(
            any("prompt-named framework" in r for r in result[0]["reason"])
        )

    def test_unknown_category_returns_empty_list(self):
        result = self.rec.recommend(_cls("no_such_category"))
        self.assertEqual(result, [])

    def test_candidate_shape(self):
        entry = self.rec.recommend(_cls("e2e_ui"))[0]
        for key in ("framework", "category", "file_extension", "reason", "confidence"):
            self.assertIn(key, entry)


if __name__ == "__main__":
    unittest.main()


class TestSyntheticDataLicenseWarning(unittest.TestCase):
    """SDV is preferred for synthetic_data, with a surfaced BSL license warning."""

    def setUp(self):
        self.rec = FrameworkRecommender()

    def test_sdv_is_preferred_for_synthetic_data(self):
        result = self.rec.recommend(_cls("synthetic_data"))
        self.assertEqual(result[0]["framework"], "sdv")
        # Faker remains available as an alternative.
        self.assertIn("faker", [c["framework"] for c in result])

    def test_sdv_candidate_carries_license_warning(self):
        top = self.rec.recommend(_cls("synthetic_data"))[0]
        self.assertEqual(top["license"], "BSL-1.1")
        self.assertIn("review", top["warning"].lower())
        # The caveat is echoed into the reason list as well.
        self.assertTrue(any("review" in r.lower() for r in top["reason"]))

    def test_faker_has_no_license_warning(self):
        faker = next(
            c for c in self.rec.recommend(_cls("synthetic_data"))
            if c["framework"] == "faker"
        )
        self.assertNotIn("warning", faker)
