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

    def test_invalid_framework(self):
        with self.assertRaises(ValueError):
            self.scaffolder.scaffold("nonexistent", project_root=str(self.test_root))

if __name__ == '__main__':
    unittest.main()
