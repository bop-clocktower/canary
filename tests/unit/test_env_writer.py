"""Tests for agent.core.env_writer — idempotent .env merge."""

import tempfile
import unittest
from pathlib import Path

from agent.core.env_writer import detect_unsafe_patterns, merge_env


class TestMergeEnv(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_writes_new_file_when_absent(self):
        env_path = self.tmp_path / ".env"
        result = merge_env(env_path, {"FOO": "1"})
        self.assertTrue(env_path.exists())
        self.assertEqual(env_path.read_text(), "FOO=1\n")
        self.assertEqual(
            result, {"added": ["FOO"], "preserved": [], "skipped": [], "reason": ""}
        )

    def test_appends_missing_keys_only(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text("BAR=2\n")
        merge_env(env_path, {"FOO": "1", "BAR": "3"})
        text = env_path.read_text()
        self.assertIn("BAR=2\n", text)
        self.assertIn("FOO=1\n", text)
        self.assertNotIn("BAR=3", text)

    def test_returns_added_and_preserved(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text("BAR=2\n")
        result = merge_env(env_path, {"FOO": "1", "BAR": "3"})
        self.assertEqual(
            result,
            {"added": ["FOO"], "preserved": ["BAR"], "skipped": [], "reason": ""},
        )

    def test_skips_empty_values(self):
        env_path = self.tmp_path / ".env"
        result = merge_env(env_path, {"FOO": ""})
        self.assertFalse(env_path.exists())
        self.assertEqual(
            result, {"added": [], "preserved": [], "skipped": [], "reason": ""}
        )

    def test_handles_comments_and_blank_lines(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text("# c\n\nBAR=2\n")
        result = merge_env(env_path, {"BAR": "3"})
        self.assertEqual(
            result, {"added": [], "preserved": ["BAR"], "skipped": [], "reason": ""}
        )

    # --- refuse to modify files with quoted / multiline values --------

    def test_refuses_to_modify_quoted_double(self):
        env_path = self.tmp_path / ".env"
        original = 'EXISTING="value with spaces"\n'
        env_path.write_text(original)
        result = merge_env(env_path, {"NEW_KEY": "abc"})
        self.assertEqual(env_path.read_text(), original)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["preserved"], [])
        self.assertEqual(result["skipped"], ["NEW_KEY"])
        self.assertIn("quoted value", result["reason"])

    def test_refuses_to_modify_quoted_single(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text("EXISTING='value with spaces'\n")
        result = merge_env(env_path, {"NEW_KEY": "abc"})
        self.assertEqual(result["skipped"], ["NEW_KEY"])
        self.assertIn("quoted value", result["reason"])

    def test_refuses_to_modify_multiline_quoted(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text('EXISTING="line one\nline two"\n')
        result = merge_env(env_path, {"NEW_KEY": "abc"})
        self.assertEqual(result["skipped"], ["NEW_KEY"])
        self.assertIn("multiline", result["reason"])

    def test_skipped_excludes_empty_additions(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text('EXISTING="x y"\n')
        result = merge_env(env_path, {"NEW": "abc", "EMPTY": ""})
        self.assertEqual(result["skipped"], ["NEW"])


class TestDetectUnsafePatterns(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_returns_none_for_simple_file(self):
        env_path = self.tmp_path / ".env"
        env_path.write_text("# comment\n\nFOO=bar\nBAZ=qux\n")
        self.assertIsNone(detect_unsafe_patterns(env_path))

    def test_returns_none_for_missing_file(self):
        self.assertIsNone(detect_unsafe_patterns(self.tmp_path / "missing.env"))


if __name__ == "__main__":
    unittest.main()
