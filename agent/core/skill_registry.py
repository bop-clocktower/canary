"""Discovers Canary skills: bundled defaults and local project overlays.

Implements the discovery convention defined in docs/specs/skill-discovery.md.

Skills are SKILL.md files with YAML-style frontmatter. The optional ``cli:``
and ``entry:`` frontmatter fields let a skill ship executable code alongside
its prose:

- ``cli:`` — filesystem path (relative to the skill directory) of an
  executable to invoke as a subprocess.
- ``entry:`` — Python ``module:callable`` string to call in-process. Reserved
  for skills bundled as installed packages.

These fields are mutually exclusive; specifying both is rejected at discovery.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

_AGENTS_SKILLS_DIR = Path(__file__).parents[2] / "agents" / "skills"


@dataclass
class SkillInfo:
    """A discovered skill.

    ``cli``/``entry`` are populated only when the SKILL.md frontmatter
    declares them; markdown-only skills leave both ``None``.
    """

    name: str
    path: Path  # the SKILL.md file
    source: str  # "bundled" | "local"
    description: str = ""
    cli: Optional[str] = None
    entry: Optional[str] = None
    # Shapes this skill should be deployed to during `canary migrate`.
    # Values match MigrationContext.detected_shape: "api", "e2e", "load",
    # "frontend_unit", etc. Empty list means the skill is not auto-deployed.
    # Use ["all"] to deploy regardless of shape.
    deploy_to: list[str] = field(default_factory=list)
    # Validation error captured at discovery time. When set, the skill is
    # still listed (so users can see the bad config) but ``canary skills
    # run`` will refuse to invoke it.
    error: Optional[str] = None

    @property
    def dir(self) -> Path:
        """Directory containing SKILL.md — base for relative cli paths."""
        return self.path.parent

    @property
    def is_executable(self) -> bool:
        return (self.cli is not None or self.entry is not None) and self.error is None


class SkillRegistry:
    """Discover skills from bundled defaults and ``.canary/skills/`` overlays.

    Precedence: local overlay skills override bundled skills of the same name.
    Discovery walks from the given root up to the nearest ``.git`` directory
    so team-level overlays placed at the repo root are found from anywhere
    inside the checkout.
    """

    def discover(self, root: Optional[Path] = None) -> list[SkillInfo]:
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

    def find(self, name: str, root: Optional[Path] = None) -> Optional[SkillInfo]:
        """Return the SkillInfo for ``name`` honoring precedence, or None."""
        for skill in self.discover(root):
            if skill.name == name:
                return skill
        return None

    # ------------------------------------------------------------------
    # Bundled skill sources
    # ------------------------------------------------------------------

    def _bundled_slash_skills(self) -> list[SkillInfo]:
        """Flat ``*.md`` files in ``agents/skills/`` — Claude Code slash commands."""
        results: list[SkillInfo] = []
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
        """Nested ``claude-code/<name>/SKILL.md`` — prescriptive harness skills."""
        results: list[SkillInfo] = []
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
        """Skills in ``<candidate>/.canary/skills/<name>/SKILL.md``."""
        results: list[SkillInfo] = []
        overlay_dir = candidate / ".canary" / "skills"
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

    @staticmethod
    def _ancestors_to_git_root(start: Path) -> list[Path]:
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

    def _parse_flat(self, path: Path, source: str) -> Optional[SkillInfo]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        fm = self._parse_frontmatter(text)
        name = fm.get("name") or path.stem
        return SkillInfo(
            name=name,
            path=path,
            source=source,
            description=fm.get("description", ""),
            cli=fm.get("cli"),
            entry=fm.get("entry"),
            deploy_to=self._parse_deploy_to(fm),
            error=self._validate_executable_fields(fm),
        )

    def _parse_nested(
        self, path: Path, dir_name: str, source: str
    ) -> Optional[SkillInfo]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        fm = self._parse_frontmatter(text)
        name = fm.get("name") or dir_name
        description = fm.get("description") or self._blockquote_tagline(text)
        return SkillInfo(
            name=name,
            path=path,
            source=source,
            description=description,
            cli=fm.get("cli"),
            entry=fm.get("entry"),
            deploy_to=self._parse_deploy_to(fm),
            error=self._validate_executable_fields(fm),
        )

    @staticmethod
    def _parse_deploy_to(fm: dict) -> list[str]:
        raw = fm.get("deploy_to", [])
        if isinstance(raw, list):
            return [str(v).strip() for v in raw if str(v).strip()]
        if isinstance(raw, str) and raw:
            return [raw.strip()]
        return []

    @staticmethod
    def _parse_frontmatter(text: str) -> dict:
        """Tiny YAML-subset parser: top-level scalar and flow-list fields.

        Supports ``key: value`` and ``key: [a, b, c]`` lines between ``---``
        delimiters. No nesting, no block sequences, no quoting.
        """
        result: dict = {}
        if not text.startswith("---"):
            return result
        lines = text.split("\n")
        for line in lines[1:]:
            if line.strip() == "---":
                break
            if not line or line.lstrip().startswith("#"):
                continue
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            v = value.strip()
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1]
                result[key.strip()] = [
                    item.strip() for item in inner.split(",") if item.strip()
                ]
            else:
                result[key.strip()] = v
        return result

    @staticmethod
    def _validate_executable_fields(fm: dict[str, str]) -> Optional[str]:
        """Return an error string if cli/entry combination is invalid."""
        cli = fm.get("cli")
        entry = fm.get("entry")
        if cli and entry:
            return "skill declares both cli: and entry: — they are mutually exclusive"
        return None

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


def resolve_cli_path(skill: SkillInfo) -> Path:
    """Resolve ``skill.cli`` to an absolute path inside the skill directory.

    Raises:
        ValueError: if the skill has no ``cli:`` field, the path escapes the
            skill dir after symlink resolution, or the target doesn't exist.
    """
    if not skill.cli:
        raise ValueError(f"skill '{skill.name}' has no cli: field")
    skill_dir = skill.dir.resolve()
    candidate = (skill_dir / skill.cli).resolve()
    try:
        candidate.relative_to(skill_dir)
    except ValueError:
        raise ValueError(
            f"skill '{skill.name}' cli path escapes the skill directory: "
            f"{skill.cli!r}"
        )
    if not candidate.exists():
        raise ValueError(
            f"skill '{skill.name}' cli target does not exist: {skill.cli!r}"
        )
    return candidate


def is_executable_skill_allowed(allow_flag: bool) -> bool:
    """Whether to honor cli:/entry: invocation in the current context.

    In non-interactive contexts (no TTY, or ``CI=true``) executable skills
    require an explicit opt-in via ``--allow-executable-skills`` to prevent
    a freshly cloned malicious overlay from silently executing code on the
    next CI run. Interactive contexts allow execution by default.
    """
    if allow_flag:
        return True
    if os.environ.get("CI", "").lower() in ("1", "true", "yes"):
        return False
    if not sys.stdin.isatty():
        return False
    return True
