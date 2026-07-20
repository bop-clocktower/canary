"""`canary feedback` — in-CLI issue reporting (#345)."""

from __future__ import annotations

import json
import unittest
from urllib.parse import parse_qs, urlparse

from typer.testing import CliRunner

from agent.cli import app
from agent.core.feedback import (
    VALID_CATEGORIES,
    build_feedback,
    build_issue_url,
    collect_context,
)


class TestFeedbackCore(unittest.TestCase):
    def test_context_has_non_sensitive_fields_only(self):
        ctx = collect_context()
        self.assertIn("version", ctx)
        self.assertIn("os", ctx)
        self.assertIn("python", ctx)
        # Must never leak env vars or file contents.
        joined = json.dumps(ctx).lower()
        self.assertNotIn("secret", joined)
        self.assertNotIn("token", joined)
        self.assertNotIn("api_key", joined)

    def test_build_feedback_bundles_message_category_context(self):
        fb = build_feedback("login button is broken", "bug")
        self.assertEqual(fb["category"], "bug")
        self.assertEqual(fb["message"], "login button is broken")
        self.assertIn("context", fb)
        self.assertIn("issue_url", fb)

    def test_issue_url_is_prefilled_and_encoded(self):
        url = build_issue_url("bug", "spaces and & symbols", {"version": "5.11.0"})
        parsed = urlparse(url)
        self.assertIn("github.com", parsed.netloc)
        self.assertTrue(parsed.path.endswith("/issues/new"))
        q = parse_qs(parsed.query)
        # Title carries the category; body carries the message + context.
        self.assertIn("bug", q["title"][0].lower())
        self.assertIn("spaces and & symbols", q["body"][0])
        self.assertIn("5.11.0", q["body"][0])
        self.assertIn("labels", q)

    def test_valid_categories(self):
        self.assertEqual(VALID_CATEGORIES, ("bug", "ux", "docs", "idea"))


class TestFeedbackCli(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_json_output_carries_url_and_payload(self):
        result = self.runner.invoke(
            app, ["feedback", "great tool", "--category", "idea", "--json"]
        )
        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertEqual(payload["category"], "idea")
        self.assertEqual(payload["message"], "great tool")
        self.assertIn("issue_url", payload)
        self.assertIn("github.com", payload["issue_url"])

    def test_human_output_shows_payload_and_url_without_auto_sending(self):
        result = self.runner.invoke(app, ["feedback", "a ux nit", "--category", "ux"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("ux", result.output)
        self.assertIn("a ux nit", result.output)
        self.assertIn("issues/new", result.output)

    def test_invalid_category_exits_nonzero(self):
        result = self.runner.invoke(
            app, ["feedback", "msg", "--category", "not-a-category"]
        )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("category", result.output.lower())

    def test_missing_message_exits_nonzero_with_hint(self):
        result = self.runner.invoke(app, ["feedback"])
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("message", result.output.lower())


if __name__ == "__main__":
    unittest.main()
