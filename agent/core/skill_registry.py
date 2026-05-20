from __future__ import annotations

# agent/core/skill_registry.py
"""Discovers Oracle skills: bundled defaults and local project overlays."""

from dataclasses import dataclass
from pathlib import Path

_AGENTS_SKILLS_DIR = Path(__file__).parents[2] / "agents" / "skills"


@dataclass
class SkillInfo:
    name: str
    path: Path
    source: str  # "bundled" | "local"
    description: str = ""


class SkillRegistry:
    """Discover skills from bundled defaults and .oracle/skills/ overlays.

    Precedence: local overlay skills override bundled skills of the same name.
    Discovery walks from the given root up to the nearest .git directory so
    team-level overlays placed at the repo root are always found.
    """

    def discover(self, root: Path | None = None) -> list[SkillInfo]:
        skills: dict[str, SkillInfo] = {}

        for info in self._bundled_slash_skills():
            skills[info.name] = info

        for info in self._bundled_harness_skills():
            skills.setdefault(info.name, info)

        search_root = (root or Path.cwd()).resolve()
        for candidate in self._ancestors_to_git_root(search_root):
            for info in self._local_overlay_skills(candidate):
                skills[info.name] = info  # local wins

        return sorted(skills.values(), key=lambda s: s.name)

    # ------------------------------------------------------------------
    # Bundled skill sources
    # ------------------------------------------------------------------

    def _bundled_slash_skills(self) -> list[SkillInfo]:
        """Flat *.md files in agents/skills/ — Claude Code slash commands."""
        results = []
        if not _AGENTS_SKILLS_DIR.exists():
            return results
        for path in sorted(_AGENTS_SKILLS_DIR.glob("*.md")):
            if path.name == "README.md":
                continue
            info = self._parse_flat(path, "bundled")
            if info:
                results.append(info)
        return results

    def _bundled_harness_skills(self) -> list[SkillInfo]:
        """Nested claude-code/<name>/SKILL.md — prescriptive harness skills."""
        results = []
        harness_dir = _AGENTS_SKILLS_DIR / "claude-code"
        if not harness_dir.exists():
            return results
        for skill_dir in sorted(harness_dir.iterdir()):
            path = skill_dir / "SKILL.md"
            if path.exists():
                info = self._parse_nested(path, skill_dir.name, "bundled")
                if info:
                    results.append(info)
        return results

    # ------------------------------------------------------------------
    # Local overlay skills
    # ------------------------------------------------------------------

    def _local_overlay_skills(self, candidate: Path) -> list[SkillInfo]:
        """Skills in <candidate>/.oracle/skills/<name>/SKILL.md."""
        results = []
        overlay_dir = candidate / ".oracle" / "skills"
        if not overlay_dir.exists():
            return results
        for skill_dir in sorted(overlay_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            path = skill_dir / "SKILL.md"
            if path.exists():
                info = self._parse_nested(path, skill_dir.name, "local")
                if info:
                    results.append(info)
        return results

    # ------------------------------------------------------------------
    # Filesystem helpers
    # ------------------------------------------------------------------

    def _ancestors_to_git_root(self, start: Path) -> list[Path]:
        """Return directories from start up to (and including) the git root."""
        candidates: list[Path] = []
        current = start
        while True:
            candidates.append(current)
            if (current / ".git").exists():
                break
            parent = current.parent
            if parent == current:
                break
            current = parent
        return candidates

    # ------------------------------------------------------------------
    # Parsers
    # ------------------------------------------------------------------

    def _parse_flat(self, path: Path, source: str) -> SkillInfo | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        name = self._frontmatter(text, "name") or path.stem
        description = self._frontmatter(text, "description") or ""
        return SkillInfo(name=name, path=path, source=source, description=description)

    def _parse_nested(self, path: Path, dir_name: str, source: str) -> SkillInfo | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        name = self._frontmatter(text, "name") or dir_name
        description = self._frontmatter(text, "description") or self._blockquote_tagline(text)
        return SkillInfo(name=name, path=path, source=source, description=description)

    @staticmethod
    def _blockquote_tagline(text: str) -> str:
        """Extract the first blockquote block as a one-line description."""
        lines = text.split("\n")
        quote_lines: list[str] = []
        for line in lines:
            stripped = line.lstrip()
            if stripped.startswith("> "):
                quote_lines.append(stripped[2:].strip())
            elif quote_lines:
                break
        return " ".join(quote_lines)

    @staticmethod
    def _frontmatter(text: str, field: str) -> str | None:
        if not text.startswith("---"):
            return None
        lines = text.split("\n")
        for i, line in enumerate(lines[1:], 1):
            if line.strip() == "---":
                break
            if line.startswith(f"{field}:"):
                return line.split(":", 1)[1].strip()
        return None
