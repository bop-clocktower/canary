# tests/unit/test_executor.py

import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
from agent.core.executor import TestExecutor

class TestTestExecutor(unittest.TestCase):

    def setUp(self):
        self.executor = TestExecutor()

    @patch('subprocess.run')
    def test_execute_success(self, mock_run):
        mock_process = MagicMock()
        mock_process.returncode = 0
        mock_process.stdout = "Test Passed"
        mock_process.stderr = ""
        mock_run.return_value = mock_process

        file_path = Path("test.spec.ts")
        exit_code, stdout, stderr = self.executor.execute(file_path, "playwright")

        self.assertEqual(exit_code, 0)
        self.assertEqual(stdout, "Test Passed")
        self.assertIn("playwright", mock_run.call_args[0][0])

    @patch('subprocess.run')
    def test_execute_failure(self, mock_run):
        mock_process = MagicMock()
        mock_process.returncode = 1
        mock_process.stdout = ""
        mock_process.stderr = "Assertion Error"
        mock_run.return_value = mock_process

        file_path = Path("test.py")
        exit_code, stdout, stderr = self.executor.execute(file_path, "pytest")

        self.assertEqual(exit_code, 1)
        self.assertEqual(stderr, "Assertion Error")

    def test_invalid_framework(self):
        with self.assertRaises(ValueError):
            self.executor.execute(Path("test.js"), "nonexistent-framework")

if __name__ == '__main__':
    unittest.main()
