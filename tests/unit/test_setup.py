# tests/unit/test_setup.py
"""Unit tests for SetupWizard."""
import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent.core.setup import SetupWizard


class TestIsConfigured(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp)

    def test_false_when_missing(self):
        self.assertFalse(SetupWizard.is_configured(self.root))

    def test_true_when_valid(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text(
            json.dumps({"provider": "claude"})
        )
        self.assertTrue(SetupWizard.is_configured(self.root))

    def test_false_when_malformed(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text("{}")
        self.assertFalse(SetupWizard.is_configured(self.root))

    def test_false_when_empty_provider(self):
        (self.root / ".oracle").mkdir()
        (self.root / ".oracle" / "config.json").write_text(
            json.dumps({"provider": ""})
        )
        self.assertFalse(SetupWizard.is_configured(self.root))


class TestSetupWizardRun(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = Path(self.tmp)

    def _run_wizard(self, provider="claude", key="sk-test", full=False):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask", side_effect=[provider, key]), \
             patch("agent.core.setup.SetupWizard._test_connection", return_value=None), \
             patch("agent.core.setup.Confirm.ask", return_value=False):
            wizard.run(full=full)

    def test_run_writes_config_on_success(self):
        self._run_wizard()
        config = json.loads((self.root / ".oracle" / "config.json").read_text())
        self.assertEqual(config["provider"], "claude")
        self.assertIn("configured_at", config)

    def test_run_loops_on_bad_key(self):
        # First verify call raises, second succeeds.
        verify_calls = [Exception("Invalid API key"), None]

        def fake_verify(provider, api_key):
            result = verify_calls.pop(0)
            if isinstance(result, Exception):
                raise result

        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "bad-key", "good-key"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   side_effect=fake_verify), \
             patch("agent.core.setup.Confirm.ask", return_value=True):
            wizard.run()

        config = json.loads(
            (self.root / ".oracle" / "config.json").read_text()
        )
        self.assertEqual(config["provider"], "claude")


if __name__ == "__main__":
    unittest.main()
