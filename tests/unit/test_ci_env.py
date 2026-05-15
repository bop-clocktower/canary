"""Unit tests for ci_env CI detection."""

import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent.core.ci_env import is_ci


def _clean_env():
    """Return an environment dict with all CI indicator vars removed."""
    ci_vars = (
        "CI", "GITHUB_ACTIONS", "CIRCLECI", "TRAVIS", "CI_SERVER",
        "BITBUCKET_BUILD_NUMBER", "JENKINS_URL", "TEAMCITY_VERSION",
    )
    return {k: v for k, v in os.environ.items() if k not in ci_vars}


class TestIsCI(unittest.TestCase):

    def test_false_when_no_ci_vars_set(self):
        with patch.dict(os.environ, _clean_env(), clear=True):
            self.assertFalse(is_ci())

    def test_true_when_CI_set(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": "true"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_GITHUB_ACTIONS_set(self):
        with patch.dict(os.environ, {**_clean_env(), "GITHUB_ACTIONS": "true"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_CIRCLECI_set(self):
        with patch.dict(os.environ, {**_clean_env(), "CIRCLECI": "true"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_TRAVIS_set(self):
        with patch.dict(os.environ, {**_clean_env(), "TRAVIS": "true"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_CI_SERVER_set(self):
        with patch.dict(os.environ, {**_clean_env(), "CI_SERVER": "yes"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_BITBUCKET_BUILD_NUMBER_set(self):
        with patch.dict(os.environ, {**_clean_env(), "BITBUCKET_BUILD_NUMBER": "42"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_JENKINS_URL_set(self):
        with patch.dict(os.environ, {**_clean_env(), "JENKINS_URL": "http://jenkins/"}, clear=True):
            self.assertTrue(is_ci())

    def test_true_when_TEAMCITY_VERSION_set(self):
        with patch.dict(os.environ, {**_clean_env(), "TEAMCITY_VERSION": "2023.1"}, clear=True):
            self.assertTrue(is_ci())

    def test_false_when_CI_is_empty_string(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": ""}, clear=True):
            self.assertFalse(is_ci())

    def test_false_when_CI_is_zero(self):
        # "0" is non-empty — truthy in Python; any non-empty value means CI-present.
        with patch.dict(os.environ, {**_clean_env(), "CI": "0"}, clear=True):
            self.assertTrue(is_ci())


class TestExecutorCIFlags(unittest.TestCase):
    """Integration: executor appends CI flags from registry when is_ci() is True."""

    def setUp(self):
        from agent.core.executor import TestExecutor
        self.executor = TestExecutor()

    def _captured_cmd(self, framework_name: str) -> list:
        """Run execute() with subprocess mocked, return the command list used."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""
        with patch("agent.core.executor.subprocess.run", return_value=mock_result) as mock_run:
            self.executor.execute(
                file_path=Path("/tmp/test_foo.py"),
                framework_name=framework_name,
            )
            return mock_run.call_args[0][0]

    def test_pytest_ci_flags_appended_in_ci(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": "true"}, clear=True):
            cmd = self._captured_cmd("pytest")
        self.assertIn("--tb=short", cmd)
        self.assertIn("no:cacheprovider", cmd)

    def test_playwright_ci_flag_appended_in_ci(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": "true"}, clear=True):
            cmd = self._captured_cmd("playwright")
        self.assertIn("--reporter=list", cmd)

    def test_vitest_ci_flag_appended_in_ci(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": "true"}, clear=True):
            cmd = self._captured_cmd("vitest")
        self.assertIn("--reporter=verbose", cmd)

    def test_no_extra_flags_outside_ci(self):
        with patch.dict(os.environ, _clean_env(), clear=True):
            cmd = self._captured_cmd("pytest")
        self.assertNotIn("--tb=short", cmd)

    def test_k6_no_ci_flags(self):
        with patch.dict(os.environ, {**_clean_env(), "CI": "true"}, clear=True):
            cmd = self._captured_cmd("k6")
        # k6 has empty ci_flags — the base command should be unchanged
        self.assertIn("k6", cmd[0])
        # No extra flags beyond the base template tokens
        base_len = len("k6 run /tmp/test_foo.py".split())
        self.assertEqual(len(cmd), base_len)
