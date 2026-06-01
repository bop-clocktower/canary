"""Unit tests for scripts/extract_python_docstrings.py (#21).

Imports the script as a module via importlib so we can exercise the
internal helpers without subprocessing.
"""

import ast
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "extract_python_docstrings.py"
_spec = importlib.util.spec_from_file_location("_eps", _SCRIPT)
assert _spec and _spec.loader
eps = importlib.util.module_from_spec(_spec)
# Register in sys.modules before exec_module — dataclasses on Python 3.14
# looks up the module via sys.modules during @dataclass decoration; without
# this registration the decoration fails with AttributeError on a None lookup.
sys.modules["_eps"] = eps
_spec.loader.exec_module(eps)  # type: ignore[attr-defined]


class TestDefaultRoots(unittest.TestCase):

    def test_tests_is_in_default_roots(self):
        # #21: test-function docstrings must be picked up alongside agent + scripts.
        self.assertIn("tests", eps._DEFAULT_ROOTS)

    def test_tests_is_not_skipped(self):
        # We removed `tests` from _SKIP_DIRS — without that, including it as a
        # root would still be filtered out by _iter_py_files.
        self.assertNotIn("tests", eps._SKIP_DIRS)


class TestConfidence(unittest.TestCase):

    def test_long_multiline_docstring(self):
        # _confidence requires >=3 non-empty lines AND total length >=80.
        doc = (
            "line one with plenty of words to make this longer\n"
            "line two with plenty of words to make this longer\n"
            "line three with plenty of words to make this longer"
        )
        self.assertEqual(eps._confidence(doc), 0.9)

    def test_two_line_or_medium(self):
        self.assertEqual(eps._confidence("first line\nsecond line"), 0.8)

    def test_one_line(self):
        self.assertEqual(eps._confidence("short"), 0.6)

    def test_empty(self):
        self.assertEqual(eps._confidence("   \n"), 0.0)


class TestWalkSymbols(unittest.TestCase):

    def _walk(self, source: str, rel: str = "tests/unit/_tmp.py"):
        tree = ast.parse(source)
        # _walk_symbols expects an absolute path under _REPO_ROOT; fake one
        # by anchoring to the real repo root.
        fake_path = eps._REPO_ROOT / rel
        return eps._walk_symbols(tree, fake_path)

    def test_extracts_test_function_docstring(self):
        src = (
            'def test_default_is_anthropic():\n'
            '    """The default LLM provider is Anthropic when CANARY_LLM_PROVIDER is unset."""\n'
            '    pass\n'
        )
        symbols = self._walk(src)
        self.assertEqual(len(symbols), 1)
        sym = symbols[0]
        self.assertEqual(sym.kind, "function")
        self.assertIn("Anthropic", sym.docstring)

    def test_extracts_test_method_docstring_inside_class(self):
        src = (
            'class TestProviderFactory:\n'
            '    """Behavior of the LLM provider factory."""\n'
            '    def test_default_is_anthropic(self):\n'
            '        """Default provider is Anthropic when env var unset."""\n'
            '        pass\n'
        )
        symbols = self._walk(src)
        kinds = sorted(s.kind for s in symbols)
        self.assertEqual(kinds, ["class", "method"])
        method = next(s for s in symbols if s.kind == "method")
        self.assertTrue(method.qualname.endswith(".TestProviderFactory.test_default_is_anthropic"))

    def test_skips_test_without_docstring(self):
        # A docstring-less test stays a 0.5 stub from the upstream
        # `test-descriptions` extractor — this script must not emit a
        # competing low-quality node.
        src = 'def test_no_doc():\n    pass\n'
        symbols = self._walk(src)
        self.assertEqual(symbols, [])


class TestExtractAndWriteOnTestFile(unittest.TestCase):

    def test_writes_page_for_tests_domain(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            # Simulate a tests directory under a fake repo root.
            test_root = tmp / "tests"
            test_root.mkdir()
            (test_root / "test_widget.py").write_text(
                'def test_widget_color_defaults_to_blue():\n'
                '    """The widget color defaults to blue when unspecified."""\n'
                '    pass\n'
            )

            # Swap _REPO_ROOT briefly so _module_path/_domain_of resolve
            # against our tempdir instead of the real repo.
            original_root = eps._REPO_ROOT
            eps._REPO_ROOT = tmp
            try:
                out = tmp / "out"
                written = eps.extract_and_write([test_root], out, clean=False)
            finally:
                eps._REPO_ROOT = original_root

            self.assertEqual(written, 1)
            page = (out / "tests" / "tests__test_widget.md").read_text()
            self.assertIn("domain: tests", page)
            self.assertIn("defaults to blue", page)


if __name__ == "__main__":
    unittest.main()
