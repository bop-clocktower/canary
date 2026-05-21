"""Language-aware framework selection in FrameworkRecommender (#91)."""

import unittest
from agent.core.classifier import ClassificationResult
from agent.core.metadata_scanner import ProjectMetadata
from agent.core.recommender import FrameworkRecommender


def _cls(test_type: str) -> ClassificationResult:
    return ClassificationResult(intent="generate_tests", test_type=test_type, confidence=0.9)


def _ts_meta() -> ProjectMetadata:
    """Simulates a TypeScript project (has package.json deps)."""
    return ProjectMetadata(js_dependencies={"typescript": "^5.0.0", "playwright": "^1.40.0"})


def _py_meta() -> ProjectMetadata:
    """Simulates a Python project (has python packages)."""
    return ProjectMetadata(python_packages={"pytest": "8.0.0", "requests": "2.31.0"})


class TestRecommenderWithoutMetadata(unittest.TestCase):
    """Existing callers passing no metadata must behave identically to before."""

    def setUp(self):
        self.rec = FrameworkRecommender()

    def test_api_no_metadata_returns_a_framework(self):
        result = self.rec.recommend(_cls("api"))
        self.assertIsNotNone(result["framework"])

    def test_e2e_no_metadata_returns_playwright(self):
        result = self.rec.recommend(_cls("e2e_ui"))
        self.assertEqual(result["framework"], "playwright")


class TestRecommenderLanguageFilter(unittest.TestCase):

    def setUp(self):
        self.rec = FrameworkRecommender()

    def test_api_typescript_project_picks_ts_framework(self):
        """TypeScript project should not get pytest for API tests."""
        result = self.rec.recommend(_cls("api"), metadata=_ts_meta())
        self.assertNotEqual(result["framework"], "pytest",
            "pytest is Python-only; a TypeScript project should get a TS-compatible framework")

    def test_api_python_project_picks_pytest(self):
        """Python project should get pytest for API tests."""
        result = self.rec.recommend(_cls("api"), metadata=_py_meta())
        self.assertEqual(result["framework"], "pytest")

    def test_e2e_typescript_project_picks_playwright(self):
        result = self.rec.recommend(_cls("e2e_ui"), metadata=_ts_meta())
        self.assertEqual(result["framework"], "playwright")

    def test_filter_falls_back_when_no_language_match(self):
        """If no framework matches the detected language, fall back to unfiltered."""
        # k6 is the only performance framework and it's JavaScript — a Python-only
        # project would normally get no match; the fallback must still return k6.
        result = self.rec.recommend(_cls("performance"), metadata=_py_meta())
        self.assertIsNotNone(result["framework"])
        self.assertEqual(result["framework"], "k6")


class TestProjectMetadataDetectedLanguages(unittest.TestCase):

    def test_js_deps_detected_as_typescript_javascript(self):
        meta = _ts_meta()
        langs = meta.detected_languages
        self.assertIn("typescript", langs)
        self.assertIn("javascript", langs)

    def test_python_packages_detected_as_python(self):
        meta = _py_meta()
        langs = meta.detected_languages
        self.assertIn("python", langs)
        self.assertNotIn("typescript", langs)

    def test_empty_metadata_returns_empty_set(self):
        meta = ProjectMetadata()
        self.assertEqual(meta.detected_languages, set())

    def test_tsconfig_implies_typescript(self):
        meta = ProjectMetadata(tsconfig={"compilerOptions": {}})
        self.assertIn("typescript", meta.detected_languages)


if __name__ == "__main__":
    unittest.main()
