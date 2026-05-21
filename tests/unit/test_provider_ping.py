"""Tests for agent.core.provider_ping — no-cost API-key validation."""

import importlib.util
import os
import unittest
from unittest.mock import MagicMock, patch

from agent.core.provider_ping import _extract_status, ping


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


_HAS_ANTHROPIC = _has_module("anthropic")
_HAS_OPENAI = _has_module("openai")
_HAS_GEMINI = _has_module("google.genai")


class _HttpExc(Exception):
    """Stand-in for an SDK exception with a status_code attribute."""

    def __init__(self, status_code: int, message: str = ""):
        super().__init__(message or f"HTTP {status_code}")
        self.status_code = status_code


class TestPing(unittest.TestCase):

    def test_mock_provider_skips(self):
        ok, msg = ping("mock")
        self.assertTrue(ok)
        self.assertIn("no auth", msg)

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_anthropic_ping_success(self):
        fake_client = MagicMock()
        fake_client.models.list.return_value = iter([MagicMock()])
        with patch("anthropic.Anthropic", return_value=fake_client):
            ok, msg = ping("anthropic", "sk-test")
        self.assertTrue(ok)
        self.assertIn("valid", msg)

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_anthropic_ping_auth_error(self):
        with patch("anthropic.Anthropic", side_effect=Exception("401")):
            ok, msg = ping("anthropic", "bad")
        self.assertFalse(ok)
        self.assertIn("console.anthropic.com/settings/keys", msg)

    @unittest.skipUnless(_HAS_OPENAI, "openai SDK not installed")
    def test_openai_ping_success(self):
        fake_client = MagicMock()
        fake_client.models.list.return_value = iter([MagicMock()])
        with patch("openai.OpenAI", return_value=fake_client):
            ok, msg = ping("openai", "sk-test")
        self.assertTrue(ok)
        self.assertIn("valid", msg)

    @unittest.skipUnless(_HAS_OPENAI, "openai SDK not installed")
    def test_openai_ping_auth_error(self):
        with patch("openai.OpenAI", side_effect=Exception("401")):
            ok, msg = ping("openai", "bad")
        self.assertFalse(ok)
        self.assertIn("platform.openai.com/api-keys", msg)

    @unittest.skipUnless(_HAS_GEMINI, "google-genai SDK not installed")
    def test_gemini_ping_success(self):
        fake_client = MagicMock()
        fake_client.models.list.return_value = iter([MagicMock()])
        with patch("google.genai.Client", return_value=fake_client):
            ok, msg = ping("gemini", "key")
        self.assertTrue(ok)
        self.assertIn("valid", msg)


class TestExtractStatus(unittest.TestCase):

    def test_from_attribute(self):
        self.assertEqual(_extract_status(_HttpExc(401)), 401)

    def test_from_message(self):
        self.assertEqual(_extract_status(Exception("got 429 from upstream")), 429)

    def test_none_when_no_signal(self):
        self.assertIsNone(_extract_status(ValueError("nope")))


class TestStatusClassificationAndFallback(unittest.TestCase):
    """Status-aware classification + completion fallback for transient errors."""

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_auth_error_short_circuits_no_fallback(self):
        """A 401 from models.list() must NOT trigger the completion fallback."""
        fake_client = MagicMock()
        fake_client.models.list.side_effect = _HttpExc(401, "Unauthorized")
        with patch("anthropic.Anthropic", return_value=fake_client):
            ok, msg = ping("anthropic", "bad")
        self.assertFalse(ok)
        self.assertIn("invalid key", msg)
        fake_client.messages.create.assert_not_called()

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_transient_error_falls_back_to_completion(self):
        """A 429 from models.list() should fall back to a 1-token completion."""
        fake_client = MagicMock()
        fake_client.models.list.side_effect = _HttpExc(429, "rate limited")
        fake_client.messages.create.return_value = MagicMock()
        with patch("anthropic.Anthropic", return_value=fake_client):
            ok, msg = ping("anthropic", "sk-test")
        self.assertTrue(ok)
        self.assertIn("completion", msg)
        fake_client.messages.create.assert_called_once()

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_transient_then_fallback_failure_reports_failure(self):
        """Both endpoints unhappy — surface validation failed, not invalid key."""
        fake_client = MagicMock()
        fake_client.models.list.side_effect = _HttpExc(503, "unavailable")
        fake_client.messages.create.side_effect = _HttpExc(503, "still down")
        with patch("anthropic.Anthropic", return_value=fake_client):
            ok, msg = ping("anthropic", "sk-test")
        self.assertFalse(ok)
        self.assertIn("validation failed", msg)
        self.assertNotIn("invalid key", msg)

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_method_override_models_skips_fallback(self):
        """ORACLE_PING_METHOD=models means never fall back to completion."""
        fake_client = MagicMock()
        fake_client.models.list.side_effect = _HttpExc(429, "rate limited")
        with patch.dict(os.environ, {"ORACLE_PING_METHOD": "models"}):
            with patch("anthropic.Anthropic", return_value=fake_client):
                ok, msg = ping("anthropic", "sk-test")
        self.assertFalse(ok)
        self.assertIn("validation failed", msg)
        fake_client.messages.create.assert_not_called()

    @unittest.skipUnless(_HAS_ANTHROPIC, "anthropic SDK not installed")
    def test_method_override_completion_skips_models_list(self):
        """ORACLE_PING_METHOD=completion means go straight to the completion call."""
        fake_client = MagicMock()
        fake_client.messages.create.return_value = MagicMock()
        with patch.dict(os.environ, {"ORACLE_PING_METHOD": "completion"}):
            with patch("anthropic.Anthropic", return_value=fake_client):
                ok, msg = ping("anthropic", "sk-test")
        self.assertTrue(ok)
        self.assertIn("completion", msg)
        fake_client.models.list.assert_not_called()


if __name__ == "__main__":
    unittest.main()
