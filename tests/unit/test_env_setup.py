"""Tests for agent.core.env_setup — orchestrated onboarding flow."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from agent.cli import app
from agent.core import env_setup as es


class _TmpEnvBase(unittest.TestCase):
    """Per-test temp dir + env var snapshot/restore for the test files below."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self._env_snapshot = os.environ.copy()
        self._cwd_snapshot = os.getcwd()

    def tearDown(self):
        os.chdir(self._cwd_snapshot)
        os.environ.clear()
        os.environ.update(self._env_snapshot)
        self._tmp.cleanup()


class TestRunFlow(_TmpEnvBase):

    def test_run_flow_version_too_old(self):
        with patch.object(es, "_check_python_version", return_value=False):
            result = es.run_flow(
                repo_root=self.tmp_path,
                provider_prompt=lambda: "mock",
                api_key_prompt=lambda v: "",
                smoke_check=lambda: True,
                logger=lambda m: None,
            )
        self.assertFalse(result.success)
        self.assertEqual(result.reason, "python_version")

    def test_run_flow_mock_provider_happy_path(self):
        calls = {"smoke": 0}

        def smoke():
            calls["smoke"] += 1
            return True

        result = es.run_flow(
            repo_root=self.tmp_path,
            provider_prompt=lambda: "mock",
            api_key_prompt=lambda v: "should-not-be-called",
            smoke_check=smoke,
            logger=lambda m: None,
        )
        self.assertTrue(result.success)
        self.assertEqual(result.provider, "mock")
        self.assertEqual(calls["smoke"], 1)
        self.assertFalse((self.tmp_path / ".env").exists())

    def test_run_flow_writes_env_when_absent(self):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with patch("agent.core.env_setup.ping", return_value=(True, "ok")):
            result = es.run_flow(
                repo_root=self.tmp_path,
                provider_prompt=lambda: "anthropic",
                api_key_prompt=lambda v: "sk-test",
                smoke_check=lambda: True,
                logger=lambda m: None,
            )
        self.assertTrue(result.success)
        self.assertIn("ANTHROPIC_API_KEY", result.env_added)
        env_text = (self.tmp_path / ".env").read_text()
        self.assertIn("ANTHROPIC_API_KEY=sk-test", env_text)

    def test_run_flow_existing_env_var_skips_prompt(self):
        """When ANTHROPIC_API_KEY is already exported, the api_key_prompt MUST NOT
        be invoked — otherwise a user with the env set still gets prompted."""
        os.environ["ANTHROPIC_API_KEY"] = "sk-from-shell"
        prompt_spy = MagicMock(name="api_key_prompt", side_effect=AssertionError(
            "api_key_prompt called even though ANTHROPIC_API_KEY was set"
        ))
        with patch("agent.core.env_setup.ping", return_value=(True, "ok")):
            result = es.run_flow(
                repo_root=self.tmp_path,
                provider_prompt=lambda: "anthropic",
                api_key_prompt=prompt_spy,
                smoke_check=lambda: True,
                logger=lambda m: None,
            )
        self.assertTrue(result.success)
        prompt_spy.assert_not_called()


def _ok_smoke(*args, **kwargs):
    """subprocess.run side effect: git rev-parse returns cwd, oracle smoke rc=0."""
    cmd = args[0] if args else kwargs.get("args", [])
    if cmd[:2] == ["git", "rev-parse"]:
        return subprocess.CompletedProcess(cmd, 0, stdout=str(Path.cwd()), stderr="")
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


def _fail_smoke(*args, **kwargs):
    cmd = args[0] if args else kwargs.get("args", [])
    if cmd[:2] == ["git", "rev-parse"]:
        return subprocess.CompletedProcess(cmd, 0, stdout=str(Path.cwd()), stderr="")
    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")


class TestCliEnvSetup(_TmpEnvBase):

    def test_mock_provider_end_to_end(self):
        os.chdir(self.tmp_path)
        runner = CliRunner()
        with patch("agent.cli.subprocess.run", side_effect=_ok_smoke):
            result = runner.invoke(app, ["env-setup-legacy"], input="mock\n")
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("env-setup complete", result.output)
        self.assertIn("mock", result.output)

    def test_default_provider_with_existing_env(self):
        os.chdir(self.tmp_path)
        os.environ["ANTHROPIC_API_KEY"] = "sk-test"
        runner = CliRunner()
        with patch("agent.core.env_setup.ping", return_value=(True, "ok")), \
             patch("agent.cli.subprocess.run", side_effect=_ok_smoke):
            # Accept default provider (anthropic) by pressing Enter.
            result = runner.invoke(app, ["env-setup-legacy"], input="\n")
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("env-setup complete", result.output)
        self.assertIn("ANTHROPIC_API_KEY", result.output)

    def test_bad_provider_exits_nonzero(self):
        os.chdir(self.tmp_path)
        runner = CliRunner()
        with patch("agent.cli.subprocess.run", side_effect=_ok_smoke):
            result = runner.invoke(app, ["env-setup-legacy"], input="banana\n")
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Unknown provider", result.output)

    def test_ping_failure_exits_nonzero(self):
        os.chdir(self.tmp_path)
        os.environ.pop("ANTHROPIC_API_KEY", None)
        runner = CliRunner()
        bad_msg = (
            "anthropic: validation failed. Get a key at "
            "https://console.anthropic.com/settings/keys"
        )
        with patch("agent.core.env_setup.ping", return_value=(False, bad_msg)), \
             patch("agent.cli.subprocess.run", side_effect=_ok_smoke):
            result = runner.invoke(
                app, ["env-setup-legacy"], input="anthropic\nbad-key\n"
            )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("console.anthropic.com", result.output)
        self.assertFalse((self.tmp_path / ".env").exists())

    def test_smoke_failure_exits_nonzero(self):
        os.chdir(self.tmp_path)
        runner = CliRunner()
        with patch("agent.cli.subprocess.run", side_effect=_fail_smoke):
            result = runner.invoke(app, ["env-setup-legacy"], input="mock\n")
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("smoke check failed", result.output)


if __name__ == "__main__":
    unittest.main()
