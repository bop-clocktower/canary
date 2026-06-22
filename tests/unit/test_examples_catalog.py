"""Structural validation for the examples/ catalog.

Guards two invariants:
  1. Every example directory contains both prompt.txt and README.md.
  2. Every example directory is referenced in its parent README.md catalog table.

These are repository-contract tests — they catch "added a directory but forgot
the catalog row" and "deleted an example but left a broken link" without any
business-logic assertions.
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parents[2]
EXAMPLES_ROOT = REPO_ROOT / "examples"

# Top-level example directories (immediate children of examples/).
_TOP_LEVEL_SKIP = {"realworld-functions"}


def _example_dirs(root: Path) -> list[Path]:
    """Return all direct subdirectories of root that look like examples."""
    return sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))


def _catalog_links(readme: Path) -> set[str]:
    """Return all relative markdown link targets in a README table."""
    text = readme.read_text(encoding="utf-8")
    # Matches [...](some/path/) or [...](some/path)
    return {m.group(1).rstrip("/") for m in re.finditer(r"\]\(([^)]+)\)", text)}


class TestTopLevelExamples(unittest.TestCase):

    def setUp(self):
        self.readme = EXAMPLES_ROOT / "README.md"
        self.links = _catalog_links(self.readme)
        self.dirs = [
            d for d in _example_dirs(EXAMPLES_ROOT)
            if d.name not in _TOP_LEVEL_SKIP
        ]

    def test_readme_exists(self):
        self.assertTrue(self.readme.exists(), "examples/README.md is missing")

    def test_each_example_has_prompt_txt(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    (d / "prompt.txt").exists(),
                    f"examples/{d.name}/prompt.txt is missing",
                )

    def test_each_example_has_readme(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    (d / "README.md").exists(),
                    f"examples/{d.name}/README.md is missing",
                )

    def test_each_example_linked_in_catalog(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    any(d.name in link for link in self.links),
                    f"examples/{d.name} is not linked from examples/README.md",
                )


class TestRealworldFunctionExamples(unittest.TestCase):

    def setUp(self):
        self.rw_root = EXAMPLES_ROOT / "realworld-functions"
        self.readme = self.rw_root / "README.md"
        self.links = _catalog_links(self.readme) if self.readme.exists() else set()
        self.dirs = _example_dirs(self.rw_root) if self.rw_root.exists() else []

    def test_realworld_functions_dir_exists(self):
        self.assertTrue(self.rw_root.exists(), "examples/realworld-functions/ is missing")

    def test_readme_exists(self):
        self.assertTrue(self.readme.exists(), "examples/realworld-functions/README.md is missing")

    def test_each_example_has_prompt_txt(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    (d / "prompt.txt").exists(),
                    f"realworld-functions/{d.name}/prompt.txt is missing",
                )

    def test_each_example_has_readme(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    (d / "README.md").exists(),
                    f"realworld-functions/{d.name}/README.md is missing",
                )

    def test_each_example_linked_in_catalog(self):
        for d in self.dirs:
            with self.subTest(example=d.name):
                self.assertTrue(
                    any(d.name in link for link in self.links),
                    f"realworld-functions/{d.name} is not linked from its README.md",
                )

    def test_lego_tracker_example_exists(self):
        lego = self.rw_root / "lego-tracker-reconcile-collection"
        self.assertTrue(lego.is_dir())
        self.assertTrue((lego / "prompt.txt").exists())
        self.assertTrue((lego / "README.md").exists())


if __name__ == "__main__":
    unittest.main()
