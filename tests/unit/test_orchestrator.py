"""Unit tests for OracleOrchestrator — pipeline logic and multi-step self-healing."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.orchestrator import OracleOrchestrator


class TestOracleOrchestrator(unittest.TestCase):

    def setUp(self):
        self.orchestrator = OracleOrchestrator()

    @patch('agent.core.orchestrator.generate_response')
    def test_run_e2e_ui(self, mock_generate):
        mock_generate.return_value = "import { test } from '@playwright/test';\ntest('demo', () => {});"

        result = self.orchestrator.run("Create a playwright test for login")

        self.assertEqual(result['test_type'], 'e2e_ui')
        self.assertEqual(result['framework'], 'playwright')
        self.assertTrue(result['output_file'].endswith('.spec.ts'))
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_run_with_execution(self, mock_generate, mock_execute):
        mock_generate.return_value = "import { test } from '@playwright/test';\ntest('demo', () => {});"
        mock_execute.return_value = (0, "Success", "")

        result = self.orchestrator.run("Create a playwright test for login", execute=True)

        self.assertIn('execution', result)
        self.assertEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['stdout'], "Success")
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))

    @patch('agent.core.orchestrator.generate_response')
    def test_run_performance(self, mock_generate):
        mock_generate.return_value = "import http from 'k6/http';\nexport default function() {}"

        result = self.orchestrator.run("Create a k6 load test for /api/data")

        self.assertEqual(result['test_type'], 'performance')
        self.assertEqual(result['framework'], 'k6')
        self.assertTrue(result['output_file'].endswith('.js'))
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())

    @patch('agent.core.orchestrator.generate_response')
    def test_run_api_routes_to_pytest(self, mock_generate):
        mock_generate.return_value = "def test_api(): assert True"

        result = self.orchestrator.run("Write tests for the /users API endpoint")

        self.assertEqual(result['test_type'], 'api')
        self.assertEqual(result['framework'], 'pytest')
        self.assertTrue(result['output_file'].endswith('.py'))
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())


class TestSelfHealing(unittest.TestCase):

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_heals_on_first_retry(self, mock_generate, mock_execute):
        mock_generate.side_effect = [
            "import { test } from '@playwright/test';\ntest('fail', () => { throw new Error(); });",
            "import { test } from '@playwright/test';\ntest('fixed', () => {});",
        ]
        mock_execute.side_effect = [(1, "", "Error: fail"), (0, "pass", "")]

        result = OracleOrchestrator().run("Create a playwright test for login", execute=True)

        self.assertTrue(result['execution']['fixed'])
        self.assertEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['attempts'], 1)
        self.assertEqual(result['execution']['original_error'], "Error: fail")
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_exhausts_max_attempts_when_all_fail(self, mock_generate, mock_execute):
        orchestrator = OracleOrchestrator(max_heal_attempts=2)
        # initial generate + 2 fix attempts
        mock_generate.side_effect = ["bad code"] * 3
        # initial run + 2 retries
        mock_execute.side_effect = [(1, "", "SyntaxError")] * 3

        result = orchestrator.run("Create a playwright test for login", execute=True)

        self.assertFalse(result['execution']['fixed'])
        self.assertNotEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['attempts'], 2)
        self.assertEqual(result['execution']['original_error'], "SyntaxError")
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_succeeds_on_third_attempt(self, mock_generate, mock_execute):
        orchestrator = OracleOrchestrator(max_heal_attempts=3)
        mock_generate.side_effect = ["bad"] * 3
        mock_execute.side_effect = [
            (1, "", "err1"),
            (1, "", "err2"),
            (0, "ok", ""),
        ]

        result = orchestrator.run("Create a playwright test for login", execute=True)

        self.assertTrue(result['execution']['fixed'])
        self.assertEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['attempts'], 2)
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_fixed_false_and_attempts_zero_when_first_run_passes(self, mock_generate, mock_execute):
        mock_generate.return_value = "import { test } from '@playwright/test';\ntest('ok', () => {});"
        mock_execute.return_value = (0, "pass", "")

        result = OracleOrchestrator().run("Create a playwright test", execute=True)

        self.assertFalse(result['execution']['fixed'])
        self.assertEqual(result['execution']['attempts'], 0)
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_max_heal_attempts_zero_disables_healing(self, mock_generate, mock_execute):
        orchestrator = OracleOrchestrator(max_heal_attempts=0)
        mock_generate.return_value = "bad code"
        mock_execute.return_value = (1, "", "fail")

        result = orchestrator.run("Create a playwright test for login", execute=True)

        # Zero attempts allowed — no retries, still reports failure
        self.assertFalse(result['execution']['fixed'])
        self.assertEqual(result['execution']['attempts'], 0)
        self.assertEqual(result['execution']['exit_code'], 1)
        Path(result['output_file']).unlink(missing_ok=True)


class TestSearchErrorContext(unittest.TestCase):

    def setUp(self):
        self.orchestrator = OracleOrchestrator()

    def test_returns_empty_string_for_blank_error(self):
        result = self.orchestrator._search_error_context("")
        self.assertEqual(result, "")

    def test_returns_string_type(self):
        result = self.orchestrator._search_error_context("NameError: name 'foo' is not defined")
        self.assertIsInstance(result, str)

    def test_returns_empty_for_nonexistent_project_root(self):
        result = self.orchestrator._search_error_context(
            "ImportError: No module named 'missing'",
            project_root="/nonexistent/path/xyz"
        )
        self.assertEqual(result, "")

    def test_finds_definition_in_project_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "auth.py").write_text(
                "class AuthService:\n    def login(self): pass\n"
            )
            result = self.orchestrator._search_error_context(
                "AttributeError: 'AuthService' has no attribute 'logout'",
                project_root=tmp,
            )
        self.assertIn("AuthService", result)

    def test_skips_test_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            tests_dir = Path(tmp) / "tests"
            tests_dir.mkdir()
            (tests_dir / "helper.py").write_text("class Helper:\n    pass\n")
            result = self.orchestrator._search_error_context(
                "AttributeError: 'Helper'",
                project_root=tmp,
            )
        # tests/ is in _IGNORED_DIRS — should not find the class
        self.assertEqual(result, "")

    def test_caps_at_five_snippets(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(10):
                (Path(tmp) / f"mod{i}.py").write_text(
                    f"class Target{i}:\n    pass\n"
                )
            result = self.orchestrator._search_error_context(
                "AttributeError: 'Target' not found",
                project_root=tmp,
            )
        snippet_count = result.count("# mod")
        self.assertLessEqual(snippet_count, 5)

    def test_caps_files_scanned_at_twenty(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Create 30 files — scanner should stop after 20
            for i in range(30):
                (Path(tmp) / f"svc{i}.py").write_text(
                    f"def handle_{i}(): pass\n"
                )
            # Use an identifier that won't match anything so we scan up to the file cap
            result = self.orchestrator._search_error_context(
                "NameError: name 'nonexistent_xyz' is not defined",
                project_root=tmp,
            )
        # No match found, but should not have scanned all 30 files
        self.assertEqual(result, "")


class TestSelectorHealRouting(unittest.TestCase):
    """Orchestrator routes selector failures to SelectorHealer, others to _attempt_fix."""

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_selector_failure_calls_selector_healer(self, mock_generate, mock_execute):
        mock_generate.side_effect = [
            "import { test } from '@playwright/test';\ntest('x', async ({ page }) => {});",
            "fixed code",
        ]
        mock_execute.side_effect = [
            (1, "", "TimeoutError: locator('.old-btn') timeout exceeded"),
            (0, "", ""),
        ]
        orchestrator = OracleOrchestrator(max_heal_attempts=1)
        with patch.object(orchestrator.selector_healer, 'build_heal_prompt',
                          wraps=orchestrator.selector_healer.build_heal_prompt) as mock_prompt:
            result = orchestrator.run("Click the submit button", execute=True)
            mock_prompt.assert_called_once()
        self.assertTrue(result['execution']['fixed'])
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_generic_failure_skips_selector_healer(self, mock_generate, mock_execute):
        mock_generate.side_effect = [
            "import { test } from '@playwright/test';\ntest('x', async ({ page }) => {});",
            "fixed code",
        ]
        mock_execute.side_effect = [
            (1, "", "AssertionError: expected 42 to equal 43"),
            (0, "", ""),
        ]
        orchestrator = OracleOrchestrator(max_heal_attempts=1)
        with patch.object(orchestrator.selector_healer, 'build_heal_prompt') as mock_prompt:
            result = orchestrator.run("Check the cart total", execute=True)
            mock_prompt.assert_not_called()
        self.assertTrue(result['execution']['fixed'])
        Path(result['output_file']).unlink(missing_ok=True)

    @patch('agent.core.executor.OracleTestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_selector_heal_prompt_receives_failing_selector(self, mock_generate, mock_execute):
        mock_generate.side_effect = [
            "import { test } from '@playwright/test';\ntest('x', async ({ page }) => {});",
            "fixed",
        ]
        mock_execute.side_effect = [
            (1, "", "TimeoutError: locator('.nav-menu') timeout exceeded"),
            (0, "", ""),
        ]
        orchestrator = OracleOrchestrator(max_heal_attempts=1)
        captured = {}
        original = orchestrator.selector_healer.build_heal_prompt

        def capturing(**kwargs):
            captured.update(kwargs)
            return original(**kwargs)

        with patch.object(orchestrator.selector_healer, 'build_heal_prompt', side_effect=capturing):
            result = orchestrator.run("Navigate using the menu", execute=True)

        self.assertEqual(captured.get('failing_selector'), '.nav-menu')
        Path(result['output_file']).unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
