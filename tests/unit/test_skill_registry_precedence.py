"""Overlay precedence in skill resolution (#333).

The TS diagnostics (`overlay list --conflicts`, `canary doctor`) declare which
overlay wins a skill-name collision by `precedence` in overlays.json. The Python
skill loader is the runtime that actually *resolves* the winner, so it MUST pick
the same one — otherwise doctor reports a winner the engine doesn't honor.

Winner rule (mirrors npm/src/overlay-conflicts.ts): higher precedence wins;
null/absent counts as 0; an equal-precedence tie falls back to sorted
directory-name order (last wins), preserving pre-#333 behavior.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.core.skill_registry import SkillRegistry


def _write_overlay_skill(home: Path, overlay: str, skill: str, description: str) -> None:
    d = home / ".canary" / "overlays" / overlay / ".canary" / "skills" / skill
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {skill}\ndescription: {description}\n---\n\n# {skill}\n",
        encoding="utf-8",
    )


def _write_registry(home: Path, entries: list[dict]) -> None:
    (home / ".canary").mkdir(parents=True, exist_ok=True)
    (home / ".canary" / "overlays.json").write_text(
        json.dumps({"schemaVersion": 1, "overlays": entries}), encoding="utf-8"
    )


class TestOverlayPrecedence(unittest.TestCase):
    def _discover(self, home: Path):
        with patch("agent.core.skill_registry.Path.home", return_value=home):
            return {s.name: s for s in SkillRegistry().discover()}

    def test_higher_precedence_overlay_wins_the_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            # "a-ov" sorts first, so under old dir-name order it would LOSE
            # (last wins). Give it higher precedence and it must WIN.
            _write_overlay_skill(home, "a-ov", "dup", "from-a")
            _write_overlay_skill(home, "z-ov", "dup", "from-z")
            _write_registry(home, [
                {"name": "a-ov", "precedence": 10},
                {"name": "z-ov", "precedence": 1},
            ])
            skills = self._discover(home)
            self.assertEqual(skills["dup"].description, "from-a")

    def test_equal_precedence_falls_back_to_dir_name_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _write_overlay_skill(home, "a-ov", "dup", "from-a")
            _write_overlay_skill(home, "z-ov", "dup", "from-z")
            _write_registry(home, [
                {"name": "a-ov"},  # precedence absent → 0
                {"name": "z-ov"},
            ])
            # Tie: sorted dir-name order, last (z-ov) wins — pre-#333 behavior.
            self.assertEqual(self._discover(home)["dup"].description, "from-z")

    def test_missing_registry_falls_back_to_dir_name_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _write_overlay_skill(home, "a-ov", "dup", "from-a")
            _write_overlay_skill(home, "z-ov", "dup", "from-z")
            # No overlays.json at all — must not crash; dir-name order applies.
            self.assertEqual(self._discover(home)["dup"].description, "from-z")

    def test_null_precedence_loses_to_positive(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            _write_overlay_skill(home, "a-ov", "dup", "from-a")
            _write_overlay_skill(home, "z-ov", "dup", "from-z")
            _write_registry(home, [
                {"name": "a-ov", "precedence": None},  # → 0
                {"name": "z-ov", "precedence": 3},
            ])
            self.assertEqual(self._discover(home)["dup"].description, "from-z")


if __name__ == "__main__":
    unittest.main()
