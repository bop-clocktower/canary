"""The hook-customization guard catches a clobbered canary hook edit (#318 C)."""

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO / "scripts" / "check_hook_customizations.py"

# Load the guard module directly (scripts/ is not a package).
_spec = importlib.util.spec_from_file_location("check_hook_customizations", _SCRIPT)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


class TestHookCustomizationGuard(unittest.TestCase):
    def test_real_tree_is_clean(self):
        """The committed hooks carry every declared customization."""
        self.assertEqual(guard.check(_REPO), [])

    def test_detects_a_clobbered_customization(self):
        """A regeneration that drops a signature is reported, not silent."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".harness" / "hooks").mkdir(parents=True)
            # Copy every guarded hook verbatim...
            for rel in guard.CUSTOMIZATIONS:
                shutil.copyfile(_REPO / rel, root / rel)
            # ...then simulate a regeneration clobbering quality-warner's block.
            target = root / ".harness" / "hooks" / "quality-warner.js"
            target.write_text(
                target.read_text(encoding="utf-8").replace("process.exit(2)", "process.exit(0)"),
                encoding="utf-8",
            )
            problems = guard.check(root)
            self.assertTrue(problems, "a clobbered hook must be reported")
            self.assertTrue(
                any("quality-warner.js" in p for p in problems),
                problems,
            )

    def test_missing_file_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            problems = guard.check(Path(tmp))
            self.assertTrue(any("MISSING FILE" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
