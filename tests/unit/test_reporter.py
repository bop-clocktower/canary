"""Unit tests for Reporter."""

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.reporter import Reporter, SUPPORTED_FORMATS


_GENERATION_ONLY = {
    "output_file": "tests/test_auth.py",
    "test_type": "python_unit",
    "framework": "pytest",
    "reasoning": ["Python source file detected", "Standard unit test"],
}

_WITH_EXECUTION_PASS = {
    **_GENERATION_ONLY,
    "execution": {"exit_code": 0, "stdout": "1 passed", "stderr": "", "fixed": False},
}

_WITH_EXECUTION_FAIL = {
    **_GENERATION_ONLY,
    "execution": {"exit_code": 1, "stdout": "", "stderr": "AssertionError: expected True", "fixed": False},
}

_WITH_EXECUTION_FIXED = {
    **_GENERATION_ONLY,
    "execution": {"exit_code": 0, "stdout": "1 passed", "stderr": "", "fixed": True},
}


class TestSupportedFormats(unittest.TestCase):

    def test_json_and_sarif_supported(self):
        self.assertIn("json", SUPPORTED_FORMATS)
        self.assertIn("sarif", SUPPORTED_FORMATS)


class TestToJson(unittest.TestCase):

    def setUp(self):
        self.reporter = Reporter()

    def test_returns_valid_json(self):
        raw = self.reporter.to_json(_GENERATION_ONLY)
        parsed = json.loads(raw)
        self.assertEqual(parsed["framework"], "pytest")

    def test_pretty_printed(self):
        raw = self.reporter.to_json(_GENERATION_ONLY)
        self.assertIn("\n", raw)

    def test_non_serialisable_values_coerced_to_str(self):
        from pathlib import Path
        result = {**_GENERATION_ONLY, "extra": Path("/tmp/x")}
        raw = self.reporter.to_json(result)
        parsed = json.loads(raw)
        self.assertEqual(parsed["extra"], "/tmp/x")


class TestToSarif(unittest.TestCase):

    def setUp(self):
        self.reporter = Reporter()

    def _parsed(self, result):
        return json.loads(self.reporter.to_sarif(result))

    def test_sarif_version(self):
        sarif = self._parsed(_GENERATION_ONLY)
        self.assertEqual(sarif["version"], "2.1.0")

    def test_schema_key_present(self):
        sarif = self._parsed(_GENERATION_ONLY)
        self.assertIn("$schema", sarif)

    def test_single_run(self):
        sarif = self._parsed(_GENERATION_ONLY)
        self.assertEqual(len(sarif["runs"]), 1)

    def test_tool_name(self):
        sarif = self._parsed(_GENERATION_ONLY)
        self.assertEqual(sarif["runs"][0]["tool"]["driver"]["name"], "Canary")

    def test_rules_list_not_empty(self):
        sarif = self._parsed(_GENERATION_ONLY)
        rules = sarif["runs"][0]["tool"]["driver"]["rules"]
        self.assertGreater(len(rules), 0)

    def test_generation_result_always_present(self):
        sarif = self._parsed(_GENERATION_ONLY)
        results = sarif["runs"][0]["results"]
        rule_ids = [r["ruleId"] for r in results]
        self.assertIn("canary/test-generation", rule_ids)

    def test_generation_only_one_result_without_execution(self):
        sarif = self._parsed(_GENERATION_ONLY)
        self.assertEqual(len(sarif["runs"][0]["results"]), 1)

    def test_generation_level_is_none(self):
        sarif = self._parsed(_GENERATION_ONLY)
        gen = sarif["runs"][0]["results"][0]
        self.assertEqual(gen["level"], "none")

    def test_generation_properties_include_framework(self):
        sarif = self._parsed(_GENERATION_ONLY)
        props = sarif["runs"][0]["results"][0]["properties"]
        self.assertEqual(props["framework"], "pytest")

    def test_generation_includes_location_when_output_file_set(self):
        sarif = self._parsed(_GENERATION_ONLY)
        locs = sarif["runs"][0]["results"][0]["locations"]
        self.assertEqual(len(locs), 1)
        uri = locs[0]["physicalLocation"]["artifactLocation"]["uri"]
        self.assertEqual(uri, "tests/test_auth.py")

    def test_generation_no_location_when_no_output_file(self):
        result = {**_GENERATION_ONLY, "output_file": ""}
        sarif = self._parsed(result)
        locs = sarif["runs"][0]["results"][0]["locations"]
        self.assertEqual(locs, [])

    def test_execution_result_present_when_execution_in_result(self):
        sarif = self._parsed(_WITH_EXECUTION_PASS)
        rule_ids = [r["ruleId"] for r in sarif["runs"][0]["results"]]
        self.assertIn("canary/test-execution", rule_ids)

    def test_execution_level_none_on_pass(self):
        sarif = self._parsed(_WITH_EXECUTION_PASS)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertEqual(exec_r["level"], "none")

    def test_execution_level_error_on_fail(self):
        sarif = self._parsed(_WITH_EXECUTION_FAIL)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertEqual(exec_r["level"], "error")

    def test_execution_message_contains_exit_code(self):
        sarif = self._parsed(_WITH_EXECUTION_FAIL)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertIn("exit code 1", exec_r["message"]["text"])

    def test_execution_message_contains_stderr_preview(self):
        sarif = self._parsed(_WITH_EXECUTION_FAIL)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertIn("AssertionError", exec_r["message"]["text"])

    def test_stderr_truncated_at_300_chars(self):
        long_err = "x" * 400
        result = {**_GENERATION_ONLY, "execution": {"exit_code": 1, "stdout": "", "stderr": long_err, "fixed": False}}
        sarif = self._parsed(result)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertIn("…", exec_r["message"]["text"])

    def test_fixed_flag_in_execution_message(self):
        sarif = self._parsed(_WITH_EXECUTION_FIXED)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertIn("Self-healed", exec_r["message"]["text"])

    def test_execution_properties_include_exit_code(self):
        sarif = self._parsed(_WITH_EXECUTION_PASS)
        exec_r = next(r for r in sarif["runs"][0]["results"] if r["ruleId"] == "canary/test-execution")
        self.assertEqual(exec_r["properties"]["exit_code"], 0)

    def test_two_results_when_execution_present(self):
        sarif = self._parsed(_WITH_EXECUTION_PASS)
        self.assertEqual(len(sarif["runs"][0]["results"]), 2)


class TestWrite(unittest.TestCase):

    def setUp(self):
        self.reporter = Reporter()
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_json_returns_path(self):
        dest = Path(self.tmp.name) / "out.json"
        path = self.reporter.write(_GENERATION_ONLY, "json", str(dest))
        self.assertEqual(path, dest)

    def test_write_json_file_exists(self):
        dest = Path(self.tmp.name) / "out.json"
        self.reporter.write(_GENERATION_ONLY, "json", str(dest))
        self.assertTrue(dest.exists())

    def test_write_json_content_is_valid_json(self):
        dest = Path(self.tmp.name) / "out.json"
        self.reporter.write(_GENERATION_ONLY, "json", str(dest))
        parsed = json.loads(dest.read_text())
        self.assertEqual(parsed["framework"], "pytest")

    def test_write_sarif_returns_path(self):
        dest = Path(self.tmp.name) / "out.sarif"
        path = self.reporter.write(_GENERATION_ONLY, "sarif", str(dest))
        self.assertEqual(path, dest)

    def test_write_sarif_content_is_valid_sarif(self):
        dest = Path(self.tmp.name) / "out.sarif"
        self.reporter.write(_GENERATION_ONLY, "sarif", str(dest))
        parsed = json.loads(dest.read_text())
        self.assertEqual(parsed["version"], "2.1.0")

    def test_write_default_path_json(self):
        import os
        original = os.getcwd()
        os.chdir(self.tmp.name)
        try:
            path = self.reporter.write(_GENERATION_ONLY, "json")
            self.assertEqual(path.name, "canary-report.json")
        finally:
            os.chdir(original)

    def test_write_default_path_sarif(self):
        import os
        original = os.getcwd()
        os.chdir(self.tmp.name)
        try:
            path = self.reporter.write(_GENERATION_ONLY, "sarif")
            self.assertEqual(path.name, "canary-report.sarif")
        finally:
            os.chdir(original)

    def test_write_creates_parent_dirs(self):
        dest = Path(self.tmp.name) / "nested" / "deep" / "out.json"
        self.reporter.write(_GENERATION_ONLY, "json", str(dest))
        self.assertTrue(dest.exists())

    def test_write_raises_for_unsupported_format(self):
        with self.assertRaises(ValueError) as ctx:
            self.reporter.write(_GENERATION_ONLY, "xml")
        self.assertIn("xml", str(ctx.exception))

    def test_write_raises_mentions_supported_formats(self):
        with self.assertRaises(ValueError) as ctx:
            self.reporter.write(_GENERATION_ONLY, "csv")
        self.assertIn("json", str(ctx.exception))
        self.assertIn("sarif", str(ctx.exception))
