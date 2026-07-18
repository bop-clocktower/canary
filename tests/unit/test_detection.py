"""Tests for agent.core.detection — the shared "fail loud" auto-detection
helper.

Several places in the CLI auto-detect something (a test framework, a
doctor persona) and used to silently fall back to `unknown`/`None` or a
bare required-flag failure when detection was uncertain. That erodes
trust: the user has no idea *why* detection failed or what to do about
it. uncertain_detection_message() renders one clear, actionable message —
what we tried to detect, why it's uncertain, how to override it, and (when
known) the vocabulary of valid values — so every failure path reads the
same way instead of each call site inventing its own ad hoc string.
"""

import unittest

from agent.core.detection import uncertain_detection_message


class TestUncertainDetectionMessage(unittest.TestCase):
    def test_names_what_could_not_be_detected(self):
        msg = uncertain_detection_message("test framework")
        self.assertIn("test framework", msg)

    def test_includes_override_hint_when_given(self):
        msg = uncertain_detection_message(
            "test framework", override_hint="--framework <name>"
        )
        self.assertIn("--framework <name>", msg)

    def test_includes_candidates_when_given(self):
        msg = uncertain_detection_message(
            "test framework", candidates=["playwright", "pytest", "wdio"]
        )
        self.assertIn("playwright", msg)
        self.assertIn("pytest", msg)
        self.assertIn("wdio", msg)

    def test_includes_reason_when_given(self):
        msg = uncertain_detection_message(
            "test framework", reason="no config file or dependency matched"
        )
        self.assertIn("no config file or dependency matched", msg)

    def test_never_returns_bare_unknown(self):
        """The whole point: no call site should be able to produce a bare
        'unknown' with no actionable next step."""
        msg = uncertain_detection_message("test framework")
        self.assertNotEqual(msg.strip().lower(), "unknown")
        self.assertGreater(len(msg), len("unknown"))

    def test_message_is_a_single_string(self):
        msg = uncertain_detection_message(
            "doctor persona",
            candidates=["frontend", "backend"],
            override_hint="--persona <tag>",
            reason="no --persona flag was given",
        )
        self.assertIsInstance(msg, str)
        self.assertIn("doctor persona", msg)
        self.assertIn("frontend", msg)
        self.assertIn("--persona <tag>", msg)

    def test_empty_candidates_omits_candidates_section(self):
        msg = uncertain_detection_message("test framework", candidates=[])
        # Should not print an empty "Known test framework(s): ." clause.
        self.assertNotIn("Known test framework", msg)


if __name__ == "__main__":
    unittest.main()
