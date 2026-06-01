"""Framework Picker Stage 2 — observability reporting-sink routing (#129).

ReportPortal is the always-on OSS default sink; the overlay dashboard is an
opt-in additional sink keyed on CANARY_SCOPE (per OC-001). OpenTelemetry is
included as the instrumentation framework.
"""

import unittest
from unittest.mock import patch

from agent.core.classifier import ClassificationResult
from agent.core.recommender import FrameworkRecommender


def _obs(confidence: float = 0.88) -> ClassificationResult:
    return ClassificationResult(
        intent="generate_tests", test_type="observability", confidence=confidence
    )


class TestObservabilityRouting(unittest.TestCase):
    def setUp(self):
        self.rec = FrameworkRecommender()

    @patch.dict("os.environ", {}, clear=False)
    def test_reportportal_is_default_without_scope(self):
        import os
        os.environ.pop("CANARY_SCOPE", None)
        names = [c["framework"] for c in self.rec.recommend(_obs())]
        self.assertIn("reportportal", names)
        self.assertIn("opentelemetry", names)
        # No dashboard sink without a scope signal.
        self.assertFalse(any(n.endswith("-dashboard") for n in names))

    def test_dashboard_sink_added_and_ranked_first_with_scope(self):
        import os
        with patch.dict(os.environ, {"CANARY_SCOPE": "acme"}, clear=False):
            result = self.rec.recommend(_obs())
        names = [c["framework"] for c in result]
        self.assertEqual(result[0]["framework"], "acme-dashboard")
        self.assertEqual(result[0]["kind"], "reporting-sink")
        # ReportPortal is still present as the default sink.
        self.assertIn("reportportal", names)

    def test_reportportal_always_present(self):
        import os
        os.environ.pop("CANARY_SCOPE", None)
        with_scope = self.rec.recommend(_obs())
        self.assertIn("reportportal", [c["framework"] for c in with_scope])
        with patch.dict(os.environ, {"CANARY_SCOPE": "x"}, clear=False):
            self.assertIn(
                "reportportal",
                [c["framework"] for c in self.rec.recommend(_obs())],
            )

    def test_capped_at_three(self):
        import os
        with patch.dict(os.environ, {"CANARY_SCOPE": "acme"}, clear=False):
            self.assertLessEqual(len(self.rec.recommend(_obs())), 3)

    def test_candidates_carry_confidence_and_category(self):
        import os
        os.environ.pop("CANARY_SCOPE", None)
        for c in self.rec.recommend(_obs(0.77)):
            self.assertEqual(c["confidence"], 0.77)
            self.assertEqual(c["category"], "observability")

    def test_non_observability_unaffected(self):
        # Sanity: the routing branch only fires for observability.
        result = self.rec.recommend(
            ClassificationResult("generate_tests", "e2e_ui", 0.9)
        )
        self.assertEqual(result[0]["framework"], "playwright")


if __name__ == "__main__":
    unittest.main()
