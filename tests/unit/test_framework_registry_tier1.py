"""Tier-0 contract repairs + Tier-1 registry expansion (issue #335).

Locks the registry-side contracts:

Tier 0
1. ``python_unit`` is folded into ``api`` — pytest is reachable via the
   ``api`` category the classifier actually emits (no dead category).
2. schemathesis carries ``contract`` in its categories so the
   ``schemathesis -> contract`` classifier hint resolves.

Tier 1 — new entries reachable by category:
- mutmut  (mutation, Python)
- wdio    (mobile — Appium + WebdriverIO)
- hurl    (api)
- fast-check / hypothesis (new ``property`` category)
- promptfoo (new ``llm_eval`` category)
"""

import unittest

from agent.core.framework_registry import FrameworkRegistry


class TestTier0ContractRepairs(unittest.TestCase):
    def setUp(self):
        self.registry = FrameworkRegistry()

    def test_pytest_reachable_via_api_category(self):
        names = [f["name"] for f in self.registry.get_by_category("api")]
        self.assertIn("pytest", names)

    def test_python_unit_is_no_longer_a_registry_category(self):
        # Folded into api: no framework declares python_unit any more, so the
        # classifier-never-emits dead category is gone.
        self.assertEqual(self.registry.get_by_category("python_unit"), [])

    def test_schemathesis_resolves_for_contract(self):
        names = [f["name"] for f in self.registry.get_by_category("contract")]
        self.assertIn("schemathesis", names)


class TestTier1NewFrameworks(unittest.TestCase):
    def setUp(self):
        self.registry = FrameworkRegistry()

    def test_mutmut_registered_for_python_mutation(self):
        fw = self.registry.find_by_name("mutmut")
        self.assertIsNotNone(fw)
        self.assertEqual(fw["category"], "mutation")
        self.assertIn("python", fw["languages"])
        names = [f["name"] for f in self.registry.get_by_category("mutation")]
        self.assertIn("mutmut", names)

    def test_wdio_registered_for_mobile(self):
        fw = self.registry.find_by_name("wdio")
        self.assertIsNotNone(fw)
        self.assertEqual(fw["category"], "mobile")
        names = [f["name"] for f in self.registry.get_by_category("mobile")]
        self.assertIn("wdio", names)

    def test_hurl_registered_for_api(self):
        fw = self.registry.find_by_name("hurl")
        self.assertIsNotNone(fw)
        self.assertIn("hurl", fw["file_extensions"])
        names = [f["name"] for f in self.registry.get_by_category("api")]
        self.assertIn("hurl", names)

    def test_property_category_resolves(self):
        names = [f["name"] for f in self.registry.get_by_category("property")]
        self.assertIn("fast-check", names)
        self.assertIn("hypothesis", names)

    def test_llm_eval_category_resolves(self):
        names = [f["name"] for f in self.registry.get_by_category("llm_eval")]
        self.assertIn("promptfoo", names)

    def test_every_new_entry_has_execution_command(self):
        # Mutation runners legitimately run against source (no {file}); every
        # new entry must still carry a runnable command string.
        for name in ("mutmut", "wdio", "hurl", "fast-check", "hypothesis", "promptfoo"):
            with self.subTest(framework=name):
                info = self.registry.execution_info(name)
                self.assertIsNotNone(info)
                self.assertTrue(info["execution_command"])


if __name__ == "__main__":
    unittest.main()
