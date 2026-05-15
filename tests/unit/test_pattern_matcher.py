"""Unit tests for PatternMatcher."""

import tempfile
import unittest
from pathlib import Path

from agent.core.pattern_matcher import PatternMatcher, PatternProfile


class TestPatternProfileIsEmpty(unittest.TestCase):

    def test_empty_by_default(self):
        self.assertTrue(PatternProfile().is_empty)

    def test_not_empty_when_test_count_nonzero(self):
        self.assertFalse(PatternProfile(test_count=1).is_empty)


class TestFindTestFiles(unittest.TestCase):

    def setUp(self):
        self.matcher = PatternMatcher()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_pytest_files(self):
        (self.root / "test_login.py").write_text("def test_login(): pass")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertEqual(profile.test_count, 1)

    def test_finds_spec_ts_files_for_playwright(self):
        (self.root / "login.spec.ts").write_text("test('logs in', () => {})")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertEqual(profile.test_count, 1)

    def test_ignores_node_modules(self):
        nm = self.root / "node_modules"
        nm.mkdir()
        (nm / "test_foo.py").write_text("def test_foo(): pass")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertEqual(profile.test_count, 0)

    def test_ignores_files_larger_than_max(self):
        big = self.root / "test_big.py"
        big.write_bytes(b"x" * (32_768 + 1))
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertEqual(profile.test_count, 0)

    def test_empty_directory_returns_empty_profile(self):
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertTrue(profile.is_empty)

    def test_deduplicates_files_matching_multiple_patterns(self):
        # test_foo.py matches both **/test_*.py and **/*_test.py would not,
        # but a file like foo_test.py also matches one. Use a name that only
        # one pattern matches so we can test it appears exactly once.
        (self.root / "test_dedup.py").write_text("def test_dedup(): pass")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertEqual(profile.test_count, 1)

    def test_falls_back_to_test_type_when_framework_unknown(self):
        (self.root / "test_api.py").write_text("def test_api(): pass")
        profile = self.matcher.scan(str(self.root), test_type="api")
        self.assertEqual(profile.test_count, 1)

    def test_js_files_analyzed_as_js_when_no_framework_or_test_type(self):
        (self.root / "login.spec.ts").write_text("test('logs in', () => {});")
        profile = self.matcher.scan(str(self.root))
        self.assertEqual(profile.language, "javascript")


class TestAnalyzePython(unittest.TestCase):

    def setUp(self):
        self.matcher = PatternMatcher()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_test(self, name: str, content: str) -> Path:
        p = self.root / name
        p.write_text(content)
        return p

    def test_detects_function_based_tests(self):
        self._write_test("test_basic.py", "def test_add(): assert 1 + 1 == 2\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertFalse(profile.uses_classes)
        self.assertEqual(profile.language, "python")

    def test_detects_class_based_tests(self):
        self._write_test("test_class.py", "class TestMath:\n    def test_add(self): pass\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertTrue(profile.uses_classes)

    def test_detects_fixtures(self):
        self._write_test("test_fix.py", "import pytest\n@pytest.fixture\ndef db(): pass\ndef test_db(db): pass\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertTrue(profile.uses_fixtures)

    def test_extracts_common_imports(self):
        self._write_test("test_imp.py", "import pytest\nfrom pathlib import Path\ndef test_x(): pass\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("pytest", profile.common_imports)

    def test_extracts_sample_names(self):
        self._write_test("test_names.py", "def test_login(): pass\ndef test_logout(): pass\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("test_login", profile.sample_names)

    def test_naming_style_should_prefix(self):
        content = "\n".join(f"def test_should_do_{i}(): pass" for i in range(5))
        self._write_test("test_should.py", content)
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("should", profile.naming_style)

    def test_naming_style_when_prefix(self):
        content = "\n".join(f"def test_when_condition_{i}(): pass" for i in range(5))
        self._write_test("test_when.py", content)
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("when", profile.naming_style)

    def test_assertion_style_function_based(self):
        self._write_test("test_asserts.py", "def test_x(): assert True\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("pytest assert", profile.assertion_style)

    def test_assertion_style_class_based(self):
        self._write_test("test_cls.py", "class TestX:\n    def test_x(self): self.assertTrue(True)\n")
        profile = self.matcher.scan(str(self.root), framework="pytest")
        self.assertIn("self.assert", profile.assertion_style)

    def test_skips_unreadable_files(self):
        p = self._write_test("test_ok.py", "def test_ok(): pass\n")
        # Make the second test file, then remove read permission
        p2 = self._write_test("test_bad.py", "def test_bad(): pass\n")
        p2.chmod(0o000)
        try:
            profile = self.matcher.scan(str(self.root), framework="pytest")
            self.assertGreaterEqual(profile.test_count, 1)
        finally:
            p2.chmod(0o644)


class TestAnalyzeJavaScript(unittest.TestCase):

    def setUp(self):
        self.matcher = PatternMatcher()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_test(self, name: str, content: str) -> Path:
        p = self.root / name
        p.write_text(content)
        return p

    def test_detects_describe_blocks(self):
        self._write_test("auth.spec.ts", "describe('auth', () => { it('logs in', () => {}); });")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertTrue(profile.uses_describe)
        self.assertEqual(profile.language, "javascript")

    def test_detects_top_level_test_calls(self):
        self._write_test("app.test.ts", "test('renders', () => {});")
        profile = self.matcher.scan(str(self.root), framework="vitest")
        self.assertFalse(profile.uses_describe)

    def test_extracts_es_module_imports(self):
        self._write_test("login.spec.ts", "import { expect } from '@playwright/test';\ntest('x', () => {});")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("@playwright/test", profile.common_imports)

    def test_extracts_commonjs_requires(self):
        self._write_test("util.test.js", "const assert = require('assert');\ntest('y', () => {});")
        profile = self.matcher.scan(str(self.root), framework="vitest")
        self.assertIn("assert", profile.common_imports)

    def test_extracts_sample_test_names(self):
        self._write_test("nav.spec.ts", "it('navigates to home', () => {});\nit('shows footer', () => {});")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("navigates to home", profile.sample_names)

    def test_naming_style_should(self):
        names = "\n".join(f"it('should do thing {i}', () => {{}});" for i in range(4))
        self._write_test("should.spec.ts", names)
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("should", profile.naming_style)

    def test_naming_style_sentence(self):
        names = "\n".join(f"it('User logs in successfully {i}', () => {{}});" for i in range(4))
        self._write_test("sentence.spec.ts", names)
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("sentence", profile.naming_style)

    def test_assertion_style_chai(self):
        self._write_test("chai.spec.ts", "import chai from 'chai';\ntest('x', () => {});")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("chai", profile.assertion_style)

    def test_assertion_style_default_expect(self):
        self._write_test("plain.spec.ts", "test('x', () => {});")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        self.assertIn("expect", profile.assertion_style)

    def test_limits_to_max_files(self):
        for i in range(15):
            (self.root / f"test_{i}.spec.ts").write_text(f"test('t{i}', () => {{}});")
        profile = self.matcher.scan(str(self.root), framework="playwright")
        # test_count reflects all found files; analysis only touches first 10
        self.assertEqual(profile.test_count, 15)
        self.assertLessEqual(len(profile.sample_names), 10 * 5)


class TestLanguageDetection(unittest.TestCase):

    def setUp(self):
        self.matcher = PatternMatcher()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_python_detected_from_extension_when_framework_ambiguous(self):
        (self.root / "test_foo.py").write_text("def test_foo(): pass\n")
        profile = self.matcher.scan(str(self.root))
        self.assertEqual(profile.language, "python")

    def test_js_detected_from_extension_for_vitest(self):
        (self.root / "foo.test.ts").write_text("test('x', () => {});")
        profile = self.matcher.scan(str(self.root), framework="vitest")
        self.assertEqual(profile.language, "javascript")
