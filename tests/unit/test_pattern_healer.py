"""Tests for agent.core.pattern_healer."""
import unittest
import textwrap
from pathlib import Path
import tempfile

from agent.core.pattern_healer import PatternHealer


def _py_file(tmp_dir: str, content: str) -> Path:
    f = Path(tmp_dir) / "test_sample.py"
    f.write_text(textwrap.dedent(content))
    return f


def _ts_file(tmp_dir: str, content: str) -> Path:
    f = Path(tmp_dir) / "sample.spec.ts"
    f.write_text(textwrap.dedent(content))
    return f


class TestHealSleep(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_heals_time_sleep(self):
        f = _py_file(self.tmp, "import time\ntime.sleep(2)\n")
        result = self.healer.heal(f)
        self.assertTrue(result.changed)
        self.assertTrue(any(c.rule == "HEAL-001" for c in result.changes))
        self.assertNotIn("time.sleep", result.patched_content)
        self.assertIn("TODO(canary)", result.patched_content)

    def test_heal_sleep_preserves_indentation(self):
        f = _py_file(self.tmp, "def test_foo():\n    time.sleep(1)\n")
        result = self.healer.heal(f)
        self.assertTrue(result.changed)
        for line in result.patched_content.splitlines():
            if "TODO(canary)" in line:
                self.assertTrue(line.startswith("    "))


class TestHealWaitForTimeout(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_heals_wait_for_timeout(self):
        f = _ts_file(self.tmp, "await page.waitForTimeout(3000);\n")
        result = self.healer.heal(f)
        self.assertTrue(result.changed)
        self.assertTrue(any(c.rule == "HEAL-002" for c in result.changes))
        self.assertNotIn("waitForTimeout", result.patched_content)
        self.assertIn("TODO(canary)", result.patched_content)

    def test_heals_wait_for_timeout_without_await(self):
        f = _ts_file(self.tmp, "page.waitForTimeout(500);\n")
        result = self.healer.heal(f)
        self.assertTrue(result.changed)
        self.assertTrue(any(c.rule == "HEAL-002" for c in result.changes))


class TestHealMissingAwait(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_heals_missing_await(self):
        f = _ts_file(self.tmp, "page.click('#btn');\n")
        result = self.healer.heal(f)
        self.assertTrue(result.changed)
        self.assertTrue(any(c.rule == "HEAL-003" for c in result.changes))
        self.assertIn("await page.click", result.patched_content)

    def test_no_change_when_await_present(self):
        f = _ts_file(self.tmp, "  await page.click('#btn');\n")
        result = self.healer.heal(f)
        self.assertFalse(any(c.rule == "HEAL-003" for c in result.changes))


class TestSkippedSelectors(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_skips_brittle_selectors(self):
        f = _ts_file(self.tmp, 'await page.locator(".submit-btn").click();\n')
        result = self.healer.heal(f)
        self.assertTrue(result.skipped)
        self.assertTrue(any("selector" in s.lower() for s in result.skipped))
        self.assertIn(".submit-btn", result.patched_content)


class TestApplyWritesToDisk(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_apply_writes_to_disk(self):
        f = _py_file(self.tmp, "time.sleep(1)\n")
        result = self.healer.apply(f)
        self.assertTrue(result.changed)
        self.assertNotIn("time.sleep", f.read_text())


class TestCleanFile(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_clean_file_no_changes(self):
        f = _py_file(self.tmp, "def test_foo():\n    assert 1 + 1 == 2\n")
        result = self.healer.heal(f)
        self.assertFalse(result.changed)
        self.assertEqual(result.changes, [])


class TestMultipleFixes(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_multiple_sleep_fixes(self):
        f = _py_file(self.tmp, "import time\ntime.sleep(1)\ntime.sleep(2)\n")
        result = self.healer.heal(f)
        heal_001 = [c for c in result.changes if c.rule == "HEAL-001"]
        self.assertEqual(len(heal_001), 2)


class TestHealResultProperties(unittest.TestCase):

    def setUp(self):
        self.healer = PatternHealer()
        self.tmp = tempfile.mkdtemp()

    def test_changed_false_when_no_changes(self):
        f = _py_file(self.tmp, "def test_foo():\n    assert True\n")
        result = self.healer.heal(f)
        self.assertFalse(result.changed)

    def test_file_path_recorded(self):
        f = _py_file(self.tmp, "time.sleep(1)\n")
        result = self.healer.heal(f)
        self.assertEqual(result.file, str(f))


if __name__ == "__main__":
    unittest.main()
