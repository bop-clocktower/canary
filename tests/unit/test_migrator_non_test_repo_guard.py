"""Regression: `canary migrate` must not misclassify a skills/docs overlay repo
as a migratable test suite (issue #319 C).

`detect()` treated any dir with **both** `harness.config.json` and `.harness/`
as a migratable harness test-project. A skills/docs overlay repo has both, so
`canary migrate` at its root tried to scaffold a suite into it, and the MCP
surface returned a misleading "no harness.config.json found" even though the
real reason was "this isn't a test project."

The guard fires only for a clear overlay signal — no test `entryPoints` and
every declared layer is a docs/skills layer — so a real test suite (which has
test entry points and/or code layers) is never blocked.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent.core.migrator import HarnessMigrator


def _harness_project(root: Path, config: dict) -> None:
    (root / "harness.config.json").write_text(json.dumps(config), encoding="utf-8")
    (root / ".harness").mkdir()


class TestSkillsDocsOverlayGuard(unittest.TestCase):
    def test_skills_docs_overlay_is_not_a_test_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "language": "python",
                "entryPoints": [],
                "layers": [
                    {"name": "skills", "pattern": ".canary/skills/**"},
                    {"name": "docs", "pattern": "docs/**"},
                ],
            })
            ctx = HarnessMigrator().detect(root)
            self.assertFalse(ctx.is_harness_project)
            # The distinction the issue asks for: not "no config", but
            # "config present, not a test project".
            self.assertIsNotNone(ctx.not_test_project_reason)
            self.assertIn("overlay", ctx.not_test_project_reason.lower())

    def test_missing_entrypoints_key_with_only_doc_layers_is_guarded(self):
        """`entryPoints` absent entirely is the same signal as an empty list."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "layers": [{"name": "docs", "pattern": "docs/**"}],
            })
            ctx = HarnessMigrator().detect(root)
            self.assertFalse(ctx.is_harness_project)
            self.assertIsNotNone(ctx.not_test_project_reason)

    def test_real_test_project_with_entrypoints_is_not_guarded(self):
        """A project that declares test entry points migrates normally."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "language": "python",
                "entryPoints": ["agent.cli:app"],
                "layers": [{"name": "skills", "pattern": ".canary/skills/**"}],
            })
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(ctx.is_harness_project)
            self.assertIsNone(ctx.not_test_project_reason)

    def test_code_layers_are_not_guarded_even_without_entrypoints(self):
        """Only *docs/skills* layers trip the guard; code layers do not."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "layers": [
                    {"name": "core", "pattern": "src/core/**"},
                    {"name": "tests", "pattern": "tests/**"},
                ],
            })
            ctx = HarnessMigrator().detect(root)
            self.assertTrue(ctx.is_harness_project)

    def test_migrate_raises_distinct_error_for_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _harness_project(root, {
                "entryPoints": [],
                "layers": [{"name": "skills", "pattern": ".canary/skills/**"}],
            })
            with self.assertRaises(ValueError) as ctx:
                HarnessMigrator().migrate(root)
            # Must NOT claim the config is missing — it plainly exists.
            self.assertNotIn("Expected harness.config.json", str(ctx.exception))
            self.assertIn("overlay", str(ctx.exception).lower())

    def test_no_config_at_all_keeps_the_generic_message(self):
        """The pre-existing 'no config' path is unchanged (no reason attached)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ctx = HarnessMigrator().detect(root)
            self.assertFalse(ctx.is_harness_project)
            self.assertIsNone(ctx.not_test_project_reason)


if __name__ == "__main__":
    unittest.main()
