"""HTTP verb/path signal detection in TestClassifier (#90)."""

import unittest
from agent.core.classifier import TestClassifier


class TestHttpVerbPathSignals(unittest.TestCase):

    def setUp(self):
        self.clf = TestClassifier()

    def _assert_api(self, prompt, min_confidence=0.9):
        result = self.clf.classify(prompt)
        self.assertEqual(
            result.test_type, "api",
            f"Expected 'api' for {prompt!r}, got {result.test_type!r}",
        )
        self.assertGreaterEqual(result.confidence, min_confidence)

    def test_get_with_path(self):
        self._assert_api("test getting all avatars from GET /avatars; verify 200 status")

    def test_post_with_nested_path(self):
        self._assert_api("test enrolling user in challenge via POST /challenges/{id}/enroll")

    def test_delete_with_path(self):
        self._assert_api("DELETE /users/{userId} should return 204")

    def test_put_with_path(self):
        self._assert_api("PUT /items/{id} updates the item and returns 200")

    def test_patch_with_path(self):
        self._assert_api("PATCH /profile endpoint updates display name")

    def test_get_health_check(self):
        self._assert_api("verify GET /health returns 200")

    def test_post_orders_path(self):
        self._assert_api("POST /orders creates a new order with the correct payload")

    def test_bare_http_verb_without_path(self):
        """Uppercase HTTP verb without a slash path is still a strong API signal."""
        result = self.clf.classify("POST a new order with bearer token")
        self.assertEqual(result.test_type, "api")

    def test_verb_match_is_case_insensitive_when_path_present(self):
        """Verb+path match is case-insensitive — lowercase verb with path still routes to api."""
        result = self.clf.classify("get /users should return a list")
        self.assertEqual(result.test_type, "api")

    def test_plain_english_verb_not_triggered(self):
        """Lowercase 'delete'/'get' in prose without a path should not trigger the HTTP rule."""
        result = self.clf.classify("delete the user account from the UI")
        self.assertTrue(
            result.test_type != "api" or result.confidence < 0.9,
            f"Expected non-api or low-confidence, got {result.test_type} @ {result.confidence}",
        )


if __name__ == "__main__":
    unittest.main()
