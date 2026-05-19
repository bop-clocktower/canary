# tests/unit/test_setup.py
"""Unit tests for SetupWizard."""
import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch

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
        mock_verify = Mock(
            side_effect=[Exception("Invalid API key"), None]
        )
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "bad-key", "good-key"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   mock_verify), \
             patch("agent.core.setup.Confirm.ask", return_value=True):
            wizard.run()

        self.assertEqual(mock_verify.call_count, 2)
        config = json.loads(
            (self.root / ".oracle" / "config.json").read_text()
        )
        self.assertEqual(config["provider"], "claude")

    def test_run_exits_when_user_declines_retry(self):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "bad-key"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   side_effect=Exception("Invalid API key")), \
             patch("agent.core.setup.Confirm.ask", return_value=False):
            with self.assertRaises(SystemExit):
                wizard.run()

        config_path = self.root / ".oracle" / "config.json"
        self.assertFalse(config_path.exists())

    def test_no_partial_config_on_interrupt(self):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=KeyboardInterrupt):
            with self.assertRaises(SystemExit):
                wizard.run()

        config_path = self.root / ".oracle" / "config.json"
        self.assertFalse(config_path.exists())

    def test_setup_full_invokes_orchestrator(self):
        wizard = SetupWizard(output_dir=self.root)
        with patch("agent.core.setup.Prompt.ask",
                   side_effect=["claude", "sk-test"]), \
             patch("agent.core.setup.SetupWizard._test_connection",
                   return_value=None), \
             patch("agent.core.setup.Confirm.ask", return_value=False), \
             patch("agent.core.setup.OracleOrchestrator") as mock_orch:
            mock_orch.return_value.run.return_value = {
                "output_file": "tests/generated/sample.spec.ts"
            }
            wizard.run(full=True)

        mock_orch.return_value.run.assert_called_once()


from typer.testing import CliRunner
from agent.cli import app
from unittest.mock import MagicMock, patch
import io

_runner = CliRunner()


class TTYInput(io.BytesIO):
    """A BytesIO that reports isatty() as True."""

    def isatty(self):
        return True


class TestAppCallback(unittest.TestCase):

    def test_skips_when_configured(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=True):
            result = _runner.invoke(app, ["version"])
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_skips_when_not_tty(self):
        # CliRunner sets stdin to a non-TTY by default
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False):
            result = _runner.invoke(app, ["version"])
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_skips_with_no_setup_flag(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False):
            result = _runner.invoke(app, ["--no-setup", "version"], input=TTYInput())
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_skips_when_setup_subcommand(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False):
            result = _runner.invoke(app, ["setup"], input=TTYInput())
        self.assertNotIn("Oracle isn't configured", result.output)

    def test_prompts_when_unconfigured_tty(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False), \
             patch("agent.core.setup.Confirm.ask",
                   return_value=False) as mock_confirm:
            result = _runner.invoke(app, ["version"], input=TTYInput())
        mock_confirm.assert_called_once()
        self.assertIn(
            "Oracle isn't configured", mock_confirm.call_args[0][0]
        )

    def test_runs_wizard_when_user_says_yes(self):
        with patch("agent.core.setup.SetupWizard.is_configured",
                   return_value=False), \
             patch("agent.core.setup.Confirm.ask", return_value=True), \
             patch("agent.core.setup.SetupWizard.run") as mock_run:
            result = _runner.invoke(app, ["version"], input=TTYInput())
        mock_run.assert_called_once_with()

    def test_setup_command_runs_wizard(self):
        with patch("agent.core.setup.SetupWizard.run") as mock_run:
            result = _runner.invoke(app, ["setup"])
        mock_run.assert_called_once_with(full=False)
        self.assertEqual(result.exit_code, 0)


if __name__ == "__main__":
    unittest.main()
