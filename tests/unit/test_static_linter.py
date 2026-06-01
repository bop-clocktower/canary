"""Tests for agent.core.static_linter."""
import textwrap
from pathlib import Path

import pytest

from agent.core.static_linter import StaticLinter, Finding


@pytest.fixture
def linter():
    return StaticLinter()


@pytest.fixture
def tmp_py(tmp_path):
    def _make(content: str) -> Path:
        f = tmp_path / "test_sample.py"
        f.write_text(textwrap.dedent(content))
        return f
    return _make


@pytest.fixture
def tmp_ts(tmp_path):
    def _make(content: str) -> Path:
        f = tmp_path / "sample.spec.ts"
        f.write_text(textwrap.dedent(content))
        return f
    return _make


# ---------------------------------------------------------------------------
# Flakiness — FLAKE-001 (sleep)
# ---------------------------------------------------------------------------

def test_detects_time_sleep(linter, tmp_py):
    f = tmp_py("import time\ntime.sleep(2)\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-001" for fi in findings)


def test_detects_waitForTimeout(linter, tmp_ts):
    f = tmp_ts("await page.waitForTimeout(3000);\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-001" for fi in findings)


def test_no_false_positive_on_clean_sleep_comment(linter, tmp_py):
    f = tmp_py("# time.sleep(2) — removed\n")
    findings = linter.flake_check(f)
    assert not any(fi.rule == "FLAKE-001" for fi in findings)


# ---------------------------------------------------------------------------
# Flakiness — FLAKE-002 (setTimeout without waitFor)
# ---------------------------------------------------------------------------

def test_detects_setTimeout_without_waitFor(linter, tmp_ts):
    f = tmp_ts("setTimeout(() => {}, 1000);\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-002" for fi in findings)


def test_no_flag_setTimeout_with_waitFor(linter, tmp_ts):
    f = tmp_ts("await page.waitForFunction(() => setTimeout(() => {}, 0));\n")
    findings = linter.flake_check(f)
    assert not any(fi.rule == "FLAKE-002" for fi in findings)


# ---------------------------------------------------------------------------
# Flakiness — FLAKE-003 (random)
# ---------------------------------------------------------------------------

def test_detects_math_random(linter, tmp_ts):
    f = tmp_ts("const x = Math.random();\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-003" for fi in findings)


def test_detects_python_random(linter, tmp_py):
    f = tmp_py("import random\nx = random.randint(1, 10)\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-003" for fi in findings)


# ---------------------------------------------------------------------------
# Flakiness — FLAKE-004 (timestamp)
# ---------------------------------------------------------------------------

def test_detects_date_now(linter, tmp_ts):
    f = tmp_ts("const ts = Date.now();\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-004" for fi in findings)


def test_detects_datetime_now(linter, tmp_py):
    f = tmp_py("from datetime import datetime\nnow = datetime.now()\n")
    findings = linter.flake_check(f)
    assert any(fi.rule == "FLAKE-004" for fi in findings)


# ---------------------------------------------------------------------------
# Selector lint — LINT-001/002/003
# ---------------------------------------------------------------------------

def test_detects_css_class_selector(linter, tmp_ts):
    f = tmp_ts('page.locator(".submit-btn").click();\n')
    findings = linter.lint(f)
    assert any(fi.rule == "LINT-001" for fi in findings)


def test_detects_css_id_selector(linter, tmp_ts):
    f = tmp_ts('page.locator("#username").fill("test");\n')
    findings = linter.lint(f)
    assert any(fi.rule == "LINT-002" for fi in findings)


def test_detects_xpath_selector(linter, tmp_ts):
    f = tmp_ts('page.locator("//div[@class=\'btn\']").click();\n')
    findings = linter.lint(f)
    assert any(fi.rule == "LINT-003" for fi in findings)


def test_no_flag_role_locator(linter, tmp_ts):
    f = tmp_ts('await page.getByRole("button", { name: "Submit" }).click();\n')
    findings = linter.lint(f)
    assert not any(fi.rule in ("LINT-001", "LINT-002", "LINT-003") for fi in findings)


# ---------------------------------------------------------------------------
# Missing await — LINT-004
# ---------------------------------------------------------------------------

def test_detects_missing_await(linter, tmp_ts):
    f = tmp_ts("  page.click('#btn');\n")
    findings = linter.lint(f)
    assert any(fi.rule == "LINT-004" for fi in findings)


def test_no_flag_when_await_present(linter, tmp_ts):
    f = tmp_ts("  await page.click('#btn');\n")
    findings = linter.lint(f)
    assert not any(fi.rule == "LINT-004" for fi in findings)


# ---------------------------------------------------------------------------
# Magic numbers — LINT-005
# ---------------------------------------------------------------------------

def test_detects_magic_number(linter, tmp_py):
    f = tmp_py("def test_foo():\n    assert len(items) == 42\n    assert True\n")
    findings = linter.lint(f)
    assert any(fi.rule == "LINT-005" for fi in findings)


def test_no_flag_http_status(linter, tmp_py):
    f = tmp_py("def test_foo():\n    assert response.status_code == 200\n")
    findings = linter.lint(f)
    assert not any(fi.rule == "LINT-005" for fi in findings)


def test_no_flag_single_digit(linter, tmp_py):
    f = tmp_py("def test_foo():\n    assert count == 0\n")
    findings = linter.lint(f)
    assert not any(fi.rule == "LINT-005" for fi in findings)


# ---------------------------------------------------------------------------
# Assertion-free tests — LINT-006
# ---------------------------------------------------------------------------

def test_detects_assertion_free_pytest(linter, tmp_py):
    f = tmp_py("""\
        def test_does_nothing():
            x = 1 + 1
    """)
    findings = linter.lint(f, framework="pytest")
    assert any(fi.rule == "LINT-006" for fi in findings)


def test_no_flag_pytest_with_assert(linter, tmp_py):
    f = tmp_py("""\
        def test_addition():
            assert 1 + 1 == 2
    """)
    findings = linter.lint(f, framework="pytest")
    assert not any(fi.rule == "LINT-006" for fi in findings)


def test_detects_assertion_free_js(linter, tmp_ts):
    f = tmp_ts("""\
        test('does nothing', async () => {
          const x = 1;
        });
    """)
    findings = linter.lint(f, framework="vitest")
    assert any(fi.rule == "LINT-006" for fi in findings)


# ---------------------------------------------------------------------------
# Clean file
# ---------------------------------------------------------------------------

def test_clean_file_no_findings(linter, tmp_py):
    f = tmp_py("""\
        def test_addition():
            assert 1 + 1 == 2

        def test_subtraction():
            assert 5 - 3 == 2
    """)
    findings = linter.lint(f, framework="pytest")
    assert findings == []


# ---------------------------------------------------------------------------
# Finding str representation
# ---------------------------------------------------------------------------

def test_finding_str():
    f = Finding(file="t.py", line=5, rule="FLAKE-001", severity="critical",
                message="Sleep.", suggestion="Use waitFor.")
    assert "CRITICAL" in str(f)
    assert "t.py:5" in str(f)
    assert "FLAKE-001" in str(f)
