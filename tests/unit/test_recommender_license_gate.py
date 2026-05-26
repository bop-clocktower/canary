"""Framework Picker Stage 3 — enterprise license-gate layer (#130).

Commercially-licensed entries are stripped unless their unlocking signal is
present; the OSS default for the category always remains (OSS-first).
"""

import os
import unittest
from unittest.mock import patch

from agent.core.classifier import ClassificationResult
from agent.core.recommender import FrameworkRecommender


def _cls(test_type: str) -> ClassificationResult:
    return ClassificationResult("generate_tests", test_type, 0.9)


def _names(result):
    return [c["framework"] for c in result]


class TestLicenseGate(unittest.TestCase):
    def setUp(self):
        self.rec = FrameworkRecommender()
        # Ensure a clean baseline regardless of the host environment.
        for var in ("ORACLE_LICENSE_TRICENTIS", "ORACLE_SCOPE"):
            os.environ.pop(var, None)

    def test_commercial_tools_stripped_by_default(self):
        names = _names(self.rec.recommend(_cls("e2e_ui")))
        self.assertIn("playwright", names)  # OSS default remains
        self.assertNotIn("tosca", names)
        self.assertNotIn("lambdatest", names)

    def test_tricentis_unlocked_by_license_signal(self):
        with patch.dict(os.environ, {"ORACLE_LICENSE_TRICENTIS": "1"}, clear=False):
            e2e = _names(self.rec.recommend(_cls("e2e_ui")))
            perf = _names(self.rec.recommend(_cls("performance")))
        self.assertIn("tosca", e2e)
        self.assertIn("neoload", perf)
        # OSS still ranked first (never proactively route to paid).
        self.assertEqual(self.rec.recommend(_cls("e2e_ui"))[0]["framework"], "playwright")

    def test_falsey_license_signal_stays_gated(self):
        with patch.dict(os.environ, {"ORACLE_LICENSE_TRICENTIS": "0"}, clear=False):
            self.assertNotIn("tosca", _names(self.rec.recommend(_cls("e2e_ui"))))

    def test_org_scope_unlocks_lambdatest(self):
        with patch.dict(os.environ, {"ORACLE_SCOPE": "acme"}, clear=False):
            names = _names(self.rec.recommend(_cls("e2e_ui")))
        self.assertIn("lambdatest", names)

    def test_oss_default_ranks_first_even_when_paid_unlocked(self):
        with patch.dict(
            os.environ,
            {"ORACLE_LICENSE_TRICENTIS": "1", "ORACLE_SCOPE": "acme"},
            clear=False,
        ):
            result = self.rec.recommend(_cls("e2e_ui"))
        self.assertEqual(result[0]["framework"], "playwright")

    def test_license_allowed_helper(self):
        oss = {"name": "playwright"}
        tri = {"name": "tosca", "license_gate": "ORACLE_LICENSE_TRICENTIS"}
        scoped = {"name": "x", "license_gate": "ORACLE_SCOPE", "license_scopes": ["acme"]}
        self.assertTrue(FrameworkRecommender._license_allowed(oss))
        with patch.dict(os.environ, {"ORACLE_LICENSE_TRICENTIS": "1"}, clear=False):
            self.assertTrue(FrameworkRecommender._license_allowed(tri))
        os.environ.pop("ORACLE_LICENSE_TRICENTIS", None)
        self.assertFalse(FrameworkRecommender._license_allowed(tri))
        with patch.dict(os.environ, {"ORACLE_SCOPE": "other"}, clear=False):
            self.assertFalse(FrameworkRecommender._license_allowed(scoped))
        with patch.dict(os.environ, {"ORACLE_SCOPE": "acme"}, clear=False):
            self.assertTrue(FrameworkRecommender._license_allowed(scoped))


if __name__ == "__main__":
    unittest.main()
