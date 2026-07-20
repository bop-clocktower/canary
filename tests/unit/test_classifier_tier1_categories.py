"""Tier-1 classifier routing: new ``property`` and ``llm_eval`` categories,
plus the new framework-name hints (issue #335).

Every framework we add must be reachable — either by a category keyword rule
or by an explicit framework-name hint. These tests lock both routes.
"""

import unittest

from agent.core.classifier import (
    TestClassifier,
    _FRAMEWORK_HINTS,
    extract_framework_hint,
)


class TestPropertyAndLlmEvalKeywords(unittest.TestCase):
    def setUp(self):
        self.clf = TestClassifier()

    def test_property_based_phrasing_classifies_property(self):
        cases = (
            "write a property-based test for the parser",
            "add an invariant test for the sorting function",
            "generate a quickcheck suite for encode/decode round-trips",
        )
        for prompt in cases:
            with self.subTest(prompt=prompt):
                self.assertEqual(self.clf.classify(prompt).test_type, "property")

    def test_llm_eval_phrasing_classifies_llm_eval(self):
        cases = (
            "set up an llm eval for the summarizer prompt",
            "add prompt regression testing for the chatbot",
            "evaluate llm behavior across model versions",
        )
        for prompt in cases:
            with self.subTest(prompt=prompt):
                self.assertEqual(self.clf.classify(prompt).test_type, "llm_eval")


class TestTier1FrameworkHints(unittest.TestCase):
    def setUp(self):
        self.clf = TestClassifier()

    def test_new_hints_registered(self):
        for hint in ("hurl", "wdio", "webdriverio", "fast-check", "hypothesis", "promptfoo"):
            with self.subTest(hint=hint):
                self.assertIn(hint, _FRAMEWORK_HINTS)

    def test_hurl_hint_classifies_api(self):
        self.assertEqual(
            self.clf.classify("write a hurl file for the orders endpoint").test_type,
            "api",
        )

    def test_wdio_hint_classifies_mobile(self):
        self.assertEqual(
            self.clf.classify("use wdio to drive the android checkout").test_type,
            "mobile",
        )

    def test_promptfoo_hint_classifies_llm_eval(self):
        self.assertEqual(
            self.clf.classify("use promptfoo for the assistant").test_type,
            "llm_eval",
        )

    def test_hypothesis_hint_classifies_property(self):
        self.assertEqual(
            self.clf.classify("use hypothesis on the tokenizer").test_type,
            "property",
        )

    def test_extract_returns_new_hint(self):
        self.assertEqual(extract_framework_hint("run promptfoo"), "promptfoo")


if __name__ == "__main__":
    unittest.main()
