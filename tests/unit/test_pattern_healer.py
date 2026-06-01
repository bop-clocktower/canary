"""Tests for agent.core.pattern_healer."""
import textwrap
from pathlib import Path

import pytest

from agent.core.pattern_healer import PatternHealer


@pytest.fixture
def healer():
    return PatternHealer()


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
# HEAL-001: time.sleep → TODO comment
# ---------------------------------------------------------------------------

def test_heals_time_sleep(healer, tmp_py):
    f = tmp_py("import time\ntime.sleep(2)\n")
    result = healer.heal(f)
    assert result.changed
    assert any(c.rule == "HEAL-001" for c in result.changes)
    assert "time.sleep" not in result.patched_content
    assert "TODO(canary)" in result.patched_content


def test_heal_sleep_preserves_indentation(healer, tmp_py):
    f = tmp_py("def test_foo():\n    time.sleep(1)\n")
    result = healer.heal(f)
    assert result.changed
    # Indentation of the TODO comment should match the sleep line
    for line in result.patched_content.splitlines():
        if "TODO(canary)" in line:
            assert line.startswith("    ")


# ---------------------------------------------------------------------------
# HEAL-002: page.waitForTimeout → TODO comment
# ---------------------------------------------------------------------------

def test_heals_wait_for_timeout(healer, tmp_ts):
    f = tmp_ts("await page.waitForTimeout(3000);\n")
    result = healer.heal(f)
    assert result.changed
    assert any(c.rule == "HEAL-002" for c in result.changes)
    assert "waitForTimeout" not in result.patched_content
    assert "TODO(canary)" in result.patched_content


def test_heals_wait_for_timeout_without_await(healer, tmp_ts):
    f = tmp_ts("page.waitForTimeout(500);\n")
    result = healer.heal(f)
    assert result.changed
    assert any(c.rule == "HEAL-002" for c in result.changes)


# ---------------------------------------------------------------------------
# HEAL-003: missing await before Playwright action
# ---------------------------------------------------------------------------

def test_heals_missing_await(healer, tmp_ts):
    f = tmp_ts("  page.click('#btn');\n")
    result = healer.heal(f)
    assert result.changed
    assert any(c.rule == "HEAL-003" for c in result.changes)
    assert "await page.click" in result.patched_content


def test_no_change_when_await_present(healer, tmp_ts):
    f = tmp_ts("  await page.click('#btn');\n")
    result = healer.heal(f)
    assert not any(c.rule == "HEAL-003" for c in result.changes)


# ---------------------------------------------------------------------------
# Skipped: brittle selectors are flagged but not auto-fixed
# ---------------------------------------------------------------------------

def test_skips_brittle_selectors(healer, tmp_ts):
    f = tmp_ts('await page.locator(".submit-btn").click();\n')
    result = healer.heal(f)
    assert result.skipped
    assert any("selector" in s.lower() for s in result.skipped)
    # The file content should be unchanged for selector issues
    assert ".submit-btn" in result.patched_content


# ---------------------------------------------------------------------------
# apply() writes to disk
# ---------------------------------------------------------------------------

def test_apply_writes_to_disk(healer, tmp_py):
    f = tmp_py("time.sleep(1)\n")
    result = healer.apply(f)
    assert result.changed
    assert "time.sleep" not in f.read_text()


# ---------------------------------------------------------------------------
# Clean file — no changes
# ---------------------------------------------------------------------------

def test_clean_file_no_changes(healer, tmp_py):
    f = tmp_py("def test_foo():\n    assert 1 + 1 == 2\n")
    result = healer.heal(f)
    assert not result.changed
    assert result.changes == []


# ---------------------------------------------------------------------------
# Multiple fixes in one file
# ---------------------------------------------------------------------------

def test_multiple_fixes(healer, tmp_py):
    f = tmp_py("""\
        import time
        def test_foo():
            time.sleep(1)
            time.sleep(2)
    """)
    result = healer.heal(f)
    assert len([c for c in result.changes if c.rule == "HEAL-001"]) == 2


# ---------------------------------------------------------------------------
# HealResult properties
# ---------------------------------------------------------------------------

def test_heal_result_changed_false_when_no_changes(healer, tmp_py):
    f = tmp_py("def test_foo():\n    assert True\n")
    result = healer.heal(f)
    assert result.changed is False


def test_heal_result_file_path(healer, tmp_py):
    f = tmp_py("time.sleep(1)\n")
    result = healer.heal(f)
    assert result.file == str(f)
