"""Tests for agent.core.static_linter."""
import unittest
import textwrap
from pathlib import Path
import tempfile

from agent.core.static_linter import StaticLinter, Finding


def _py_file(tmp_dir: str, content: str) -> Path:
    f = Path(tmp_dir) / "test_sample.py"
    f.write_text(textwrap.dedent(content))
    return f


def _ts_file(tmp_dir: str, content: str) -> Path:
    f = Path(tmp_dir) / "sample.spec.ts"
    f.write_text(textwrap.dedent(content))
    return f


class TestFlakinessFlakeCheck(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_detects_time_sleep(self):
        f = _py_file(self.tmp, "import time\ntime.sleep(2)\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-001" for fi in findings))

    def test_detects_waitForTimeout(self):
        f = _ts_file(self.tmp, "await page.waitForTimeout(3000);\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-001" for fi in findings))

    def test_no_false_positive_on_sleep_comment(self):
        f = _py_file(self.tmp, "# time.sleep(2) — removed\n")
        findings = self.linter.flake_check(f)
        self.assertFalse(any(fi.rule == "FLAKE-001" for fi in findings))

    def test_detects_setTimeout_without_waitFor(self):
        f = _ts_file(self.tmp, "setTimeout(() => {}, 1000);\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-002" for fi in findings))

    def test_no_flag_setTimeout_with_waitFor(self):
        f = _ts_file(self.tmp, "await page.waitForFunction(() => setTimeout(() => {}, 0));\n")
        findings = self.linter.flake_check(f)
        self.assertFalse(any(fi.rule == "FLAKE-002" for fi in findings))

    def test_detects_math_random(self):
        f = _ts_file(self.tmp, "const x = Math.random();\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-003" for fi in findings))

    def test_detects_python_random(self):
        f = _py_file(self.tmp, "import random\nx = random.randint(1, 10)\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-003" for fi in findings))

    def test_detects_date_now(self):
        f = _ts_file(self.tmp, "const ts = Date.now();\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-004" for fi in findings))

    def test_detects_datetime_now(self):
        f = _py_file(self.tmp, "from datetime import datetime\nnow = datetime.now()\n")
        findings = self.linter.flake_check(f)
        self.assertTrue(any(fi.rule == "FLAKE-004" for fi in findings))


class TestSelectorLint(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_detects_css_class_selector(self):
        f = _ts_file(self.tmp, 'page.locator(".submit-btn").click();\n')
        findings = self.linter.lint(f)
        self.assertTrue(any(fi.rule == "LINT-001" for fi in findings))

    def test_detects_css_id_selector(self):
        f = _ts_file(self.tmp, 'page.locator("#username").fill("test");\n')
        findings = self.linter.lint(f)
        self.assertTrue(any(fi.rule == "LINT-002" for fi in findings))

    def test_detects_xpath_selector(self):
        f = _ts_file(self.tmp, "page.locator(\"//div[@class='btn']\").click();\n")
        findings = self.linter.lint(f)
        self.assertTrue(any(fi.rule == "LINT-003" for fi in findings))

    def test_no_flag_role_locator(self):
        f = _ts_file(self.tmp, 'await page.getByRole("button", { name: "Submit" }).click();\n')
        findings = self.linter.lint(f)
        self.assertFalse(any(fi.rule in ("LINT-001", "LINT-002", "LINT-003") for fi in findings))


class TestMissingAwait(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_detects_missing_await(self):
        f = _ts_file(self.tmp, "  page.click('#btn');\n")
        findings = self.linter.lint(f)
        self.assertTrue(any(fi.rule == "LINT-004" for fi in findings))

    def test_no_flag_when_await_present(self):
        f = _ts_file(self.tmp, "  await page.click('#btn');\n")
        findings = self.linter.lint(f)
        self.assertFalse(any(fi.rule == "LINT-004" for fi in findings))


class TestMagicNumbers(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_detects_magic_number(self):
        f = _py_file(self.tmp, "def test_foo():\n    assert len(items) == 42\n    assert True\n")
        findings = self.linter.lint(f)
        self.assertTrue(any(fi.rule == "LINT-005" for fi in findings))

    def test_no_flag_http_status(self):
        f = _py_file(self.tmp, "def test_foo():\n    assert response.status_code == 200\n")
        findings = self.linter.lint(f)
        self.assertFalse(any(fi.rule == "LINT-005" for fi in findings))

    def test_no_flag_single_digit(self):
        f = _py_file(self.tmp, "def test_foo():\n    assert count == 0\n")
        findings = self.linter.lint(f)
        self.assertFalse(any(fi.rule == "LINT-005" for fi in findings))


class TestAssertionFreeTests(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_detects_assertion_free_pytest(self):
        f = _py_file(self.tmp, "def test_does_nothing():\n    x = 1 + 1\n")
        findings = self.linter.lint(f, framework="pytest")
        self.assertTrue(any(fi.rule == "LINT-006" for fi in findings))

    def test_no_flag_pytest_with_assert(self):
        f = _py_file(self.tmp, "def test_addition():\n    assert 1 + 1 == 2\n")
        findings = self.linter.lint(f, framework="pytest")
        self.assertFalse(any(fi.rule == "LINT-006" for fi in findings))

    def test_detects_assertion_free_js(self):
        content = "test('does nothing', async () => {\n  const x = 1;\n});\n"
        f = _ts_file(self.tmp, content)
        findings = self.linter.lint(f, framework="vitest")
        self.assertTrue(any(fi.rule == "LINT-006" for fi in findings))


class TestCleanFile(unittest.TestCase):

    def setUp(self):
        self.linter = StaticLinter()
        self.tmp = tempfile.mkdtemp()

    def test_clean_file_no_findings(self):
        f = _py_file(self.tmp, "def test_addition():\n    assert 1 + 1 == 2\n")
        findings = self.linter.lint(f, framework="pytest")
        self.assertEqual(findings, [])


class TestFindingStr(unittest.TestCase):

    def test_finding_str(self):
        f = Finding(file="t.py", line=5, rule="FLAKE-001", severity="critical",
                    message="Sleep.", suggestion="Use waitFor.")
        s = str(f)
        self.assertIn("CRITICAL", s)
        self.assertIn("t.py:5", s)
        self.assertIn("FLAKE-001", s)


if __name__ == "__main__":
    unittest.main()
