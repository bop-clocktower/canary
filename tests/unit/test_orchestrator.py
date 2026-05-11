"""
Unit tests for the OracleOrchestrator class.

These tests verify the core pipeline logic, including classification,
framework recommendation, code generation, and self-healing.
"""

import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
from agent.core.orchestrator import OracleOrchestrator

class TestOracleOrchestrator(unittest.TestCase):
    """
    Test suite for the OracleOrchestrator class.
    """

    def setUp(self):
        """
        Sets up a fresh orchestrator instance for each test.
        """
        self.orchestrator = OracleOrchestrator()

    @patch('agent.core.orchestrator.generate_response')
    def test_run_e2e_ui(self, mock_generate):
        """
        Verifies the E2E UI test generation flow.
        """
        mock_generate.return_value = "import { test } from '@playwright/test';\ntest('demo', () => {});"
        
        prompt = "Create a playwright test for login"
        result = self.orchestrator.run(prompt)
        
        self.assertEqual(result['test_type'], 'e2e_ui')
        self.assertEqual(result['framework'], 'playwright')
        self.assertTrue(result['output_file'].endswith('.spec.ts'))
        
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())

    @patch('agent.core.executor.TestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_run_with_execution(self, mock_generate, mock_execute):
        """
        Verifies the pipeline when immediate test execution is requested.
        """
        mock_generate.return_value = "import { test } from '@playwright/test';\ntest('demo', () => {});"
        mock_execute.return_value = (0, "Success", "")
        
        prompt = "Create a playwright test for login"
        result = self.orchestrator.run(prompt, execute=True)
        
        self.assertIn('execution', result)
        self.assertEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['stdout'], "Success")
        
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))

    @patch('agent.core.executor.TestExecutor.execute')
    @patch('agent.core.orchestrator.generate_response')
    def test_run_with_self_healing(self, mock_generate, mock_execute):
        """
        Verifies the MVP self-healing loop (re-generation after failure).
        """
        # First call to generate code, second call to fix code
        mock_generate.side_effect = [
            "import { test } from '@playwright/test';\ntest('fail', () => { throw new Error('fail'); });",
            "import { test } from '@playwright/test';\ntest('fixed', () => {});"
        ]
        
        # First execution fails, second execution succeeds
        mock_execute.side_effect = [
            (1, "", "Error: fail"),
            (0, "Success", "")
        ]
        
        prompt = "Create a playwright test for login"
        result = self.orchestrator.run(prompt, execute=True)
        
        self.assertIn('execution', result)
        self.assertTrue(result['execution']['fixed'])
        self.assertEqual(result['execution']['exit_code'], 0)
        self.assertEqual(result['execution']['original_error'], "Error: fail")
        
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))

    @patch('agent.core.orchestrator.generate_response')
    def test_run_performance(self, mock_generate):
        """
        Verifies the performance test generation flow.
        """
        mock_generate.return_value = "import http from 'k6/http';\nexport default function() {}"
        
        prompt = "Create a k6 load test for /api/data"
        result = self.orchestrator.run(prompt)
        
        self.assertEqual(result['test_type'], 'performance')
        self.assertEqual(result['framework'], 'k6')
        self.assertTrue(result['output_file'].endswith('.js'))
        
        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())

    @patch('agent.core.orchestrator.generate_response')
    def test_run_api_routes_to_pytest(self, mock_generate):
        """
        API-classified prompts must resolve to a real framework (pytest),
        not silently fall through to framework=None.
        """
        mock_generate.return_value = "def test_api(): assert True"

        prompt = "Write tests for the /users API endpoint"
        result = self.orchestrator.run(prompt)

        self.assertEqual(result['test_type'], 'api')
        self.assertEqual(result['framework'], 'pytest')
        self.assertTrue(result['output_file'].endswith('.py'))

        output_path = Path(result['output_file'])
        self.addCleanup(lambda: output_path.unlink(missing_ok=True))
        self.assertTrue(output_path.exists())


if __name__ == '__main__':
    unittest.main()
