"""Unit tests for FixtureScanner (#62)."""

import tempfile
import unittest
from pathlib import Path

from agent.core.fixture_scanner import (
    FixtureScanner,
    FixtureSymbols,
    _extract_python,
    _extract_ts,
)


class TestFixtureSymbolsIsEmpty(unittest.TestCase):

    def test_empty_by_default(self):
        self.assertTrue(FixtureSymbols().is_empty)

    def test_not_empty_when_module_present(self):
        symbols = FixtureSymbols(by_module={"a.ts": ["foo"]})
        self.assertFalse(symbols.is_empty)


class TestExtractTs(unittest.TestCase):

    def test_export_const(self):
        self.assertEqual(_extract_ts("export const apiClient = makeClient();"), ["apiClient"])

    def test_export_function(self):
        self.assertEqual(
            _extract_ts("export function expectOkResponse(r) {}"),
            ["expectOkResponse"],
        )

    def test_export_async_function(self):
        self.assertEqual(
            _extract_ts("export async function login(user) {}"),
            ["login"],
        )

    def test_export_class(self):
        self.assertEqual(_extract_ts("export class TestFixture {}"), ["TestFixture"])

    def test_export_interface_and_type(self):
        text = "export interface User {}\nexport type Id = string;"
        self.assertEqual(_extract_ts(text), ["User", "Id"])

    def test_export_default_function(self):
        self.assertEqual(
            _extract_ts("export default function makeApi() {}"),
            ["makeApi"],
        )

    def test_named_export_block(self):
        text = "const a = 1; const b = 2;\nexport { a, b };"
        self.assertEqual(_extract_ts(text), ["a", "b"])

    def test_named_export_with_alias(self):
        text = "export { internalName as publicName };"
        # alias wins — that's the importable name
        self.assertEqual(_extract_ts(text), ["publicName"])

    def test_dedupes(self):
        text = "export const x = 1;\nexport { x };"
        self.assertEqual(_extract_ts(text), ["x"])

    def test_no_exports(self):
        self.assertEqual(_extract_ts("const x = 1;"), [])


class TestExtractPython(unittest.TestCase):

    def test_def_and_class(self):
        text = "def make_client():\n    pass\nclass Fixture:\n    pass\n"
        self.assertEqual(_extract_python(text), ["make_client", "Fixture"])

    def test_skips_private(self):
        text = "def _helper(): pass\ndef public(): pass\n"
        self.assertEqual(_extract_python(text), ["public"])

    def test_dedupes(self):
        text = "def foo(): pass\ndef foo(): pass\n"
        self.assertEqual(_extract_python(text), ["foo"])


class TestFixtureScannerScan(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scanner = FixtureScanner()

    def tearDown(self):
        self.tmp.cleanup()

    def test_returns_empty_when_no_fixture_dirs(self):
        result = self.scanner.scan(str(self.root))
        self.assertTrue(result.is_empty)

    def test_scans_tests_fixtures_dir(self):
        d = self.root / "tests" / "fixtures"
        d.mkdir(parents=True)
        (d / "expects.ts").write_text(
            "export function expectOkResponse(r) {}\n"
            "export function expectUnauthorized(r) {}\n"
        )
        result = self.scanner.scan(str(self.root))
        self.assertFalse(result.is_empty)
        self.assertEqual(result.files_scanned, 1)
        self.assertIn("tests/fixtures/expects.ts", result.by_module)
        self.assertEqual(
            result.by_module["tests/fixtures/expects.ts"],
            ["expectOkResponse", "expectUnauthorized"],
        )

    def test_scans_test_utils_dir(self):
        d = self.root / "test-utils"
        d.mkdir(parents=True)
        (d / "client.ts").write_text("export const api = makeApi();")
        result = self.scanner.scan(str(self.root))
        self.assertIn("test-utils/client.ts", result.by_module)

    def test_skips_files_without_exports(self):
        d = self.root / "tests" / "fixtures"
        d.mkdir(parents=True)
        (d / "empty.ts").write_text("const x = 1; // private\n")
        result = self.scanner.scan(str(self.root))
        self.assertTrue(result.is_empty)

    def test_handles_missing_project_root(self):
        result = self.scanner.scan(str(self.root / "does-not-exist"))
        self.assertTrue(result.is_empty)


if __name__ == "__main__":
    unittest.main()
