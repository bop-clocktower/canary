"""Regression guard: the on-disk skill / command / agent discovery tree.

Gap 3 of issue #310 — the guard that would have caught the bugs fixed in #302
(SKILL.md files shipped with no YAML frontmatter → "headless" and invisible to
discovery; slash commands pointing at agents/skills that did not exist →
dangling references). It iterates the REAL tree rather than a fixture, so any
future skill/command/agent added or renamed is held to the same contract.

Contracts enforced:
  * every ``agents/skills/claude-code/*/SKILL.md`` has parseable YAML
    frontmatter carrying a non-empty ``name`` and ``description``;
  * every ``commands/*.md`` references an agent or skill that exists on disk;
  * every ``@agents/...`` reference inside ``agents/commands/**`` resolves to a
    real file (the SKILL.md / skill.yaml a Claude-Code command loads).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

_REPO = Path(__file__).resolve().parents[2]
_SKILLS_DIR = _REPO / "agents" / "skills" / "claude-code"
_COMMANDS_DIR = _REPO / "commands"
_AGENT_COMMANDS_DIR = _REPO / "agents" / "commands"

# "Use the `canary-foo` agent" / "Use the `canary-foo` skill"
_COMMAND_REF_RE = re.compile(r"Use the [`\"']([a-z0-9-]+)[`\"'] (?:agent|skill)")
# "@agents/skills/claude-code/foo/SKILL.md"
_AT_REF_RE = re.compile(r"@(agents/[\w./-]+)")


def _frontmatter(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    return yaml.safe_load(parts[1]) or {}


def _existing_agents() -> set[str]:
    return {p.stem for p in _REPO.glob("agents/*.md")}


def _existing_skills() -> set[str]:
    return {p.parent.name for p in _SKILLS_DIR.glob("*/SKILL.md")}


class TestSkillFrontmatter(unittest.TestCase):
    """Every bundled SKILL.md must be discoverable — the #302 headless bug."""

    def test_skill_dir_is_non_empty(self):
        # If this ever hits zero the glob or the tree moved; fail loudly.
        self.assertGreater(len(list(_SKILLS_DIR.glob("*/SKILL.md"))), 0)

    def test_every_skill_has_valid_frontmatter_with_name_and_description(self):
        offenders: list[str] = []
        for skill_md in sorted(_SKILLS_DIR.glob("*/SKILL.md")):
            fm = _frontmatter(skill_md)
            rel = skill_md.relative_to(_REPO)
            if fm is None:
                offenders.append(f"{rel}: missing/!unparseable YAML frontmatter")
                continue
            if not str(fm.get("name", "")).strip():
                offenders.append(f"{rel}: frontmatter has no 'name'")
            if not str(fm.get("description", "")).strip():
                offenders.append(f"{rel}: frontmatter has no 'description'")
        self.assertEqual(offenders, [], "headless/invalid skills:\n" + "\n".join(offenders))

    def test_skill_frontmatter_name_matches_directory(self):
        """A skill's declared name should match its directory (routing key)."""
        mismatches: list[str] = []
        for skill_md in sorted(_SKILLS_DIR.glob("*/SKILL.md")):
            fm = _frontmatter(skill_md) or {}
            name = str(fm.get("name", "")).strip()
            dirname = skill_md.parent.name
            if name and name != dirname:
                mismatches.append(f"{dirname} → declares name {name!r}")
        self.assertEqual(mismatches, [], "\n".join(mismatches))


class TestCommandReferences(unittest.TestCase):
    """Every slash command must point at an agent or skill that exists."""

    def test_command_dir_is_non_empty(self):
        self.assertGreater(len(list(_COMMANDS_DIR.glob("*.md"))), 0)

    def test_every_command_references_an_existing_agent_or_skill(self):
        agents = _existing_agents()
        skills = _existing_skills()
        dangling: list[str] = []
        for cmd in sorted(_COMMANDS_DIR.glob("*.md")):
            m = _COMMAND_REF_RE.search(cmd.read_text(encoding="utf-8"))
            rel = cmd.relative_to(_REPO)
            if not m:
                dangling.append(f"{rel}: no 'Use the `X` agent/skill' reference found")
                continue
            target = m.group(1)
            if target not in agents and target not in skills:
                dangling.append(f"{rel}: references {target!r} which is neither agent nor skill")
        self.assertEqual(dangling, [], "dangling command references:\n" + "\n".join(dangling))


class TestAgentCommandAtReferences(unittest.TestCase):
    """@agents/... references inside agents/commands/** must resolve on disk."""

    def test_at_references_resolve(self):
        if not _AGENT_COMMANDS_DIR.is_dir():
            self.skipTest("no agents/commands directory")
        missing: list[str] = []
        checked = 0
        for cmd in sorted(_AGENT_COMMANDS_DIR.rglob("*.md")):
            for ref in _AT_REF_RE.findall(cmd.read_text(encoding="utf-8")):
                checked += 1
                if not (_REPO / ref).exists():
                    missing.append(f"{cmd.relative_to(_REPO)} → @{ref} (missing)")
        self.assertEqual(missing, [], "unresolved @-references:\n" + "\n".join(missing))
        self.assertGreater(checked, 0, "expected at least one @agents/ reference to verify")


if __name__ == "__main__":
    unittest.main()
