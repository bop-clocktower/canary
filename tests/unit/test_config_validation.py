"""Tests for agent.core.config_validation — the shared fail-loud-but-not-
hard-fail JSON config reader.

Motivation: migrator.py and mcp_validator.py used to catch JSON/OS errors
while reading harness.config.json / .mcp.json and silently fall back as if
the file didn't exist at all, producing wrong-but-confident output instead
of telling the user their config is malformed. read_json_with_warning()
distinguishes "file genuinely absent" (silent, normal) from "file exists
but failed to parse/read" (returns a warning string the caller surfaces),
without ever raising.
"""

import tempfile
import unittest
from pathlib import Path

from agent.core.config_validation import read_json_with_warning


class TestReadJsonWithWarning(unittest.TestCase):
    def test_missing_file_returns_no_data_no_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, warning = read_json_with_warning(Path(tmp) / "absent.json")
        self.assertIsNone(data)
        self.assertIsNone(warning)

    def test_valid_json_returns_data_no_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text('{"key": "value"}', encoding="utf-8")
            data, warning = read_json_with_warning(path)
        self.assertEqual(data, {"key": "value"})
        self.assertIsNone(warning)

    def test_malformed_existing_json_returns_warning_not_none_silently(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text("{not valid json", encoding="utf-8")
            data, warning = read_json_with_warning(path)
        self.assertIsNone(data)
        self.assertIsNotNone(warning)

    def test_warning_message_identifies_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "harness.config.json"
            path.write_text("{broken", encoding="utf-8")
            _data, warning = read_json_with_warning(path)
        self.assertIn(str(path), warning)

    def test_warning_message_identifies_parse_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".mcp.json"
            path.write_text("not json at all", encoding="utf-8")
            _data, warning = read_json_with_warning(path)
        # Should mention it's a parse/JSON problem, not a generic failure.
        self.assertTrue(
            "json" in warning.lower() or "parse" in warning.lower()
        )

    def test_unreadable_existing_directory_returns_warning_not_raise(self):
        # A path that exists but is a directory (not a file) fails to read
        # as text; this must degrade to a warning, never raise.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "harness.config.json"
            path.mkdir()
            data, warning = read_json_with_warning(path)
        self.assertIsNone(data)
        self.assertIsNotNone(warning)

    def test_never_raises_on_malformed_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text("\x00\x01garbage", encoding="latin-1")
            try:
                read_json_with_warning(path)
            except Exception as exc:  # pragma: no cover - assertion is the point
                self.fail(f"read_json_with_warning raised unexpectedly: {exc}")


if __name__ == "__main__":
    unittest.main()
