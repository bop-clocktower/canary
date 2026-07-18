"""Tests that classifier.py's confidence values are documented as heuristic
priors, not calibrated probabilities.

The 0.5-0.95 confidence numbers hardcoded per keyword-match branch in
TestClassifier.classify() are hand-picked heuristic priors — there is no
statistical calibration behind them. This is a docs-only stopgap (see
docs/ideation/ease-canary-adoption-and-harde-2026-07-18.md candidate #4):
a caller relying on confidence in CI should not treat a 0.95 vs a 0.55 as
if they were calibrated probabilities. These tests assert the disclosure
is actually present in the docstrings, so the warning can't silently
regress out of the module.
"""

import unittest

from agent.core import classifier
from agent.core.classifier import ClassificationResult, TestClassifier


_DISCLOSURE_KEYWORDS = ("heuristic", "not", "calibrat")


def _mentions_heuristic_disclosure(text: str) -> bool:
    lowered = text.lower()
    return all(kw in lowered for kw in _DISCLOSURE_KEYWORDS)


class TestModuleDocstringDisclosesHeuristicConfidence(unittest.TestCase):
    def test_module_docstring_present(self):
        self.assertIsNotNone(classifier.__doc__)

    def test_module_docstring_discloses_heuristic_confidence(self):
        self.assertTrue(
            _mentions_heuristic_disclosure(classifier.__doc__ or ""),
            "classifier.py module docstring should explicitly state confidence "
            "values are hand-calibrated heuristic priors, not statistical "
            "probabilities.",
        )


class TestClassificationResultDocstringDisclosesHeuristicConfidence(unittest.TestCase):
    def test_class_docstring_discloses_heuristic_confidence(self):
        self.assertTrue(
            _mentions_heuristic_disclosure(ClassificationResult.__doc__ or ""),
            "ClassificationResult docstring should explicitly state that "
            "`confidence` is a heuristic prior, not a calibrated probability.",
        )


class TestClassifierClassDocstringDisclosesHeuristicConfidence(unittest.TestCase):
    def test_classifier_class_docstring_discloses_heuristic_confidence(self):
        self.assertTrue(
            _mentions_heuristic_disclosure(TestClassifier.__doc__ or ""),
            "TestClassifier docstring should explicitly state that confidence "
            "scores are hand-calibrated heuristic priors, not statistical "
            "probabilities computed from data.",
        )


if __name__ == "__main__":
    unittest.main()
