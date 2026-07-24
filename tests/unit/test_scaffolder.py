# tests/unit/test_scaffolder.py

import unittest
import shutil
from pathlib import Path
from agent.core.scaffolder import Scaffolder

class TestScaffolder(unittest.TestCase):

    def setUp(self):
        self.scaffolder = Scaffolder()
        self.test_root = Path("test_scaffold_root")
        if self.test_root.exists():
            shutil.rmtree(self.test_root)
        self.test_root.mkdir()

    def tearDown(self):
        if self.test_root.exists():
            shutil.rmtree(self.test_root)

    def test_scaffold_playwright(self):
        result = self.scaffolder.scaffold("playwright", project_root=str(self.test_root))
        
        self.assertEqual(result["framework"], "playwright")
        self.assertIn("playwright.config.ts", result["created_files"])
        self.assertIn("tests/e2e", result["created_dirs"])
        
        self.assertTrue((self.test_root / "playwright.config.ts").exists())
        self.assertTrue((self.test_root / "tests/e2e").is_dir())

    def test_scaffold_pytest(self):
        result = self.scaffolder.scaffold("pytest", project_root=str(self.test_root))
        
        self.assertEqual(result["framework"], "pytest")
        self.assertIn("pytest.ini", result["created_files"])
        self.assertIn("tests", result["created_dirs"])
        
        self.assertTrue((self.test_root / "pytest.ini").exists())
        self.assertTrue((self.test_root / "tests").is_dir())

    def test_scaffold_wdio(self):
        result = self.scaffolder.scaffold("wdio", project_root=str(self.test_root))

        self.assertEqual(result["framework"], "wdio")
        self.assertIn("wdio.conf.ts", result["created_files"])
        self.assertIn("tests", result["created_dirs"])

        self.assertTrue((self.test_root / "wdio.conf.ts").exists())
        self.assertTrue((self.test_root / "tests").is_dir())

    def test_invalid_framework(self):
        # A framework that is not even in the registry is genuinely invalid
        # input and must still raise.
        with self.assertRaises(ValueError):
            self.scaffolder.scaffold("nonexistent", project_root=str(self.test_root))

    def test_known_framework_without_template_degrades(self):
        # schemathesis is a real registry framework with no scaffold template.
        # It must degrade loudly (actionable result), NOT crash — the adopter
        # should still learn how to run it, not hit a stub.
        result = self.scaffolder.scaffold(
            "schemathesis", project_root=str(self.test_root)
        )
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["framework"], "schemathesis")
        self.assertEqual(result["created_files"], [])
        self.assertEqual(result["created_dirs"], [])
        # Actionable: a non-empty guidance string and the run command canary
        # does know for this framework.
        self.assertTrue(result["guidance"])
        self.assertIn("schemathesis", result["execution_command"])

    def test_degrade_never_writes_files(self):
        before = set(p.name for p in self.test_root.iterdir())
        self.scaffolder.scaffold("locust", project_root=str(self.test_root))
        after = set(p.name for p in self.test_root.iterdir())
        self.assertEqual(before, after)

if __name__ == '__main__':
    unittest.main()
