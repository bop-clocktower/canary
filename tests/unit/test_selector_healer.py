import json
import unittest
import zipfile
from pathlib import Path
import tempfile

from agent.core.selector_healer import SelectorHealer


class TestIsSelectorFailure(unittest.TestCase):

    def setUp(self):
        self.healer = SelectorHealer()

    def test_playwright_timeout_on_locator(self):
        error = "TimeoutError: locator('.submit-btn') timeout exceeded"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_waiting_for_selector(self):
        error = "Error: waiting for selector '.nav-menu' to be visible"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_strict_mode_violation(self):
        error = "strict mode violation: locator('[data-testid=\"modal\"]') resolved to 3 elements"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_element_not_attached(self):
        error = "Error: locator('#login-btn') not attached to the DOM"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_element_not_visible(self):
        error = "locator('.dropdown') not visible"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_get_by_role_failure(self):
        error = "TimeoutError: getByRole('button', {name: 'Submit'}) timeout"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_page_click_failure(self):
        error = "page.click('.missing-class') failed: element not found"
        self.assertTrue(self.healer.is_selector_failure(error))

    def test_generic_assertion_failure_is_not_selector(self):
        error = "AssertionError: expected 42 to equal 43"
        self.assertFalse(self.healer.is_selector_failure(error))

    def test_import_error_is_not_selector(self):
        error = "ImportError: cannot import name 'foo' from 'bar'"
        self.assertFalse(self.healer.is_selector_failure(error))

    def test_syntax_error_is_not_selector(self):
        error = "SyntaxError: Unexpected token '}'"
        self.assertFalse(self.healer.is_selector_failure(error))

    def test_empty_error_is_not_selector(self):
        self.assertFalse(self.healer.is_selector_failure(""))


class TestExtractFailingSelector(unittest.TestCase):

    def setUp(self):
        self.healer = SelectorHealer()

    def test_extracts_css_class_from_locator(self):
        error = "TimeoutError: locator('.submit-btn') timeout exceeded"
        self.assertEqual(self.healer.extract_failing_selector(error), ".submit-btn")

    def test_extracts_data_testid(self):
        error = 'locator(\'[data-testid="modal-close"]\') not attached'
        self.assertEqual(self.healer.extract_failing_selector(error), '[data-testid="modal-close"]')

    def test_extracts_id_selector(self):
        error = "waiting for selector '#login-btn'"
        self.assertEqual(self.healer.extract_failing_selector(error), "#login-btn")

    def test_extracts_get_by_role(self):
        error = "getByRole('button', {name: 'Submit'}) timeout"
        self.assertEqual(self.healer.extract_failing_selector(error), "button")

    def test_extracts_get_by_text(self):
        error = "getByText('Sign in') not visible"
        self.assertEqual(self.healer.extract_failing_selector(error), "Sign in")

    def test_extracts_get_by_test_id(self):
        error = "getByTestId('nav-menu') not found"
        self.assertEqual(self.healer.extract_failing_selector(error), "nav-menu")

    def test_extracts_page_click_selector(self):
        error = "page.click('.missing-class') failed"
        self.assertEqual(self.healer.extract_failing_selector(error), ".missing-class")

    def test_returns_none_when_no_selector_found(self):
        error = "AssertionError: expected 42 to equal 43"
        self.assertIsNone(self.healer.extract_failing_selector(error))


class TestDomContextFromReport(unittest.TestCase):

    def setUp(self):
        self.healer = SelectorHealer()

    def test_returns_empty_string_when_no_report_dir(self):
        result = self.healer.dom_context_from_report(Path("/nonexistent/path"))
        self.assertEqual(result, "")

    def test_reads_dom_snapshot_html(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            snapshot = Path(tmpdir) / "snapshot.html"
            snapshot.write_text(
                '<html><body><button class="new-btn">Click me</button></body></html>'
            )
            result = self.healer.dom_context_from_report(Path(tmpdir))
            self.assertIn("new-btn", result)
            self.assertIn("Click me", result)

    def test_truncates_large_dom(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            snapshot = Path(tmpdir) / "snapshot.html"
            snapshot.write_text("<html><body>" + "<div>x</div>" * 500 + "</body></html>")
            result = self.healer.dom_context_from_report(Path(tmpdir))
            self.assertLessEqual(len(result), 4000)

    def test_extracts_dom_from_trace_zip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Build a minimal trace zip with a snapshot entry
            zip_path = Path(tmpdir) / "trace.zip"
            snapshot_html = '<html><body><button data-testid="ok-btn">OK</button></body></html>'
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr("snapshots/snapshot1.html", snapshot_html)
            result = self.healer.dom_context_from_report(Path(tmpdir))
            self.assertIn("ok-btn", result)

    def test_returns_empty_when_zip_has_no_snapshots(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            zip_path = Path(tmpdir) / "trace.zip"
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr("meta.json", json.dumps({"version": 1}))
            result = self.healer.dom_context_from_report(Path(tmpdir))
            self.assertEqual(result, "")


class TestBuildHealPrompt(unittest.TestCase):

    def setUp(self):
        self.healer = SelectorHealer()

    def _call(self, *, dom_context="", failing_selector=None):
        return self.healer.build_heal_prompt(
            user_prompt="Click the submit button",
            framework="playwright",
            original_code="test('demo', async ({ page }) => { await page.click('.old-btn'); });",
            error="TimeoutError: locator('.old-btn') timeout",
            failing_selector=failing_selector,
            dom_context=dom_context,
        )

    def test_prompt_includes_requirement(self):
        self.assertIn("Click the submit button", self._call())

    def test_prompt_includes_original_code(self):
        self.assertIn(".old-btn", self._call())

    def test_prompt_includes_error(self):
        self.assertIn("TimeoutError", self._call())

    def test_prompt_includes_failing_selector_when_provided(self):
        prompt = self._call(failing_selector=".old-btn")
        self.assertIn("FAILING SELECTOR", prompt)
        self.assertIn(".old-btn", prompt)

    def test_prompt_omits_selector_section_when_none(self):
        prompt = self._call(failing_selector=None)
        self.assertNotIn("FAILING SELECTOR", prompt)

    def test_prompt_includes_dom_context_when_provided(self):
        prompt = self._call(dom_context="<button data-testid='ok'>OK</button>")
        self.assertIn("DOM SNAPSHOT", prompt)
        self.assertIn("data-testid", prompt)

    def test_prompt_omits_dom_section_when_empty(self):
        prompt = self._call(dom_context="")
        self.assertNotIn("DOM SNAPSHOT", prompt)

    def test_prompt_emphasises_resilient_selectors(self):
        prompt = self._call()
        self.assertIn("data-testid", prompt.lower())

    def test_prompt_requests_code_only_output(self):
        prompt = self._call()
        self.assertIn("ONLY the code", prompt)
