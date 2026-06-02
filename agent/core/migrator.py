# agent/core/migrator.py

from __future__ import annotations

"""
Canary Migrator — detects harness-scaffolded test-suite projects and migrates
them to Canary's layout without touching existing test files.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from agent.core.scaffolder import Scaffolder

# ---------------------------------------------------------------------------
# Framework detection probes
# ---------------------------------------------------------------------------

# (config_file, framework, shape, confidence)
_CONFIG_PROBES: list[tuple[str, str, str, str]] = [
    ("playwright.config.ts",  "playwright",     "e2e_ui",        "config"),
    ("playwright.config.js",  "playwright",     "e2e_ui",        "config"),
    ("cypress.config.ts",     "playwright",     "e2e_ui",        "config"),
    ("cypress.config.js",     "playwright",     "e2e_ui",        "config"),
    ("vitest.config.ts",      "vitest",         "frontend_unit", "config"),
    ("vitest.config.js",      "vitest",         "frontend_unit", "config"),
    ("vitest.config.mts",     "vitest",         "frontend_unit", "config"),
    ("jest.config.ts",        "vitest",         "frontend_unit", "config"),
    ("jest.config.js",        "vitest",         "frontend_unit", "config"),
    ("jest.config.mjs",       "vitest",         "frontend_unit", "config"),
    ("k6.config.js",          "k6",             "performance",   "config"),
    ("pytest.ini",            "pytest",         "api",           "config"),
    ("setup.cfg",             "pytest",         "api",           "config"),
    ("axe.config.js",         "axe-core",       "accessibility", "config"),
    ("backstop.json",         "backstopjs",     "visual",        "config"),
    ("pact.json",             "pact",           "contract",      "config"),
    (".pact",                 "pact",           "contract",      "config"),
    ("stryker.config.js",     "stryker",        "mutation",      "config"),
    ("stryker.config.mjs",    "stryker",        "mutation",      "config"),
    ("locust.conf",           "locust",         "load",          "config"),
    ("locustfile.py",         "locust",         "load",          "config"),
    ("wdio.conf.ts",          "wdio",           "mobile",        "config"),
    ("wdio.conf.js",          "wdio",           "mobile",        "config"),
    ("wdio.conf.mjs",         "wdio",           "mobile",        "config"),
]

# pyproject.toml section markers
_PYPROJECT_MARKERS: list[tuple[str, str, str]] = [
    ("[tool.pytest.ini_options]", "pytest", "api"),
    ("[tool.coverage",            "pytest", "api"),
]

# package.json test script → (framework, shape)
_PACKAGE_SCRIPT_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\bplaywright\b"), "playwright", "e2e_ui"),
    (re.compile(r"\bcypress\b"),    "playwright", "e2e_ui"),
    (re.compile(r"\bvitest\b"),     "vitest",     "frontend_unit"),
    (re.compile(r"\bjest\b"),       "vitest",     "frontend_unit"),
    (re.compile(r"\bk6\b"),         "k6",         "performance"),
    (re.compile(r"\blocust\b"),     "locust",     "load"),
    (re.compile(r"\bstryker\b"),    "stryker",    "mutation"),
    (re.compile(r"\bwdio\b"),       "wdio",       "mobile"),
]

# Python dependency → (framework, shape)
_PYTHON_DEP_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"^pytest\b",         re.MULTILINE | re.IGNORECASE), "pytest",         "api"),
    (re.compile(r"^locust\b",         re.MULTILINE | re.IGNORECASE), "locust",         "load"),
    (re.compile(r"^pact\b",           re.MULTILINE | re.IGNORECASE), "pact",           "contract"),
    (re.compile(r"^sdv\b",            re.MULTILINE | re.IGNORECASE), "sdv",            "synthetic_data"),
    (re.compile(r"^faker\b",          re.MULTILINE | re.IGNORECASE), "faker",          "synthetic_data"),
    (re.compile(r"^testcontainers\b", re.MULTILINE | re.IGNORECASE), "testcontainers", "integration"),
]

# Language → (framework, shape) fallbacks from harness.config.json
_LANGUAGE_FALLBACKS = {
    "python":     ("pytest",     "api"),
    "typescript": ("playwright", "e2e_ui"),
    "javascript": ("playwright", "e2e_ui"),
}

_TEST_GLOBS = [
    "tests/**/*.py",
    "test/**/*.py",
    "tests/**/*.spec.ts",
    "tests/**/*.test.ts",
    "tests/**/*.spec.js",
    "tests/**/*.test.js",
    "src/**/*.spec.ts",
    "src/**/*.test.ts",
]


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class MigrationContext:
    project_root: Path
    is_harness_project: bool
    harness_config: dict = field(default_factory=dict)
    detected_framework: Optional[str] = None
    detected_shape: str = "unknown"
    detection_source: str = "none"
    detection_confidence: str = "none"  # "config" | "content" | "language" | "none"


@dataclass
class SkillDeployResult:
    skill_name: str
    status: str   # "copied" | "skipped" | "dry_run"
    note: str = ""


@dataclass
class MigrationReport:
    framework: str
    shape: str
    dry_run: bool
    detection_source: str = ""
    detection_confidence: str = ""
    created_files: list = field(default_factory=list)
    created_dirs: list = field(default_factory=list)
    skipped_configs: list = field(default_factory=list)
    preserved_files: list = field(default_factory=list)
    would_create: list = field(default_factory=list)
    manual_followups: list = field(default_factory=list)
    deployed_skills: list[SkillDeployResult] = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = ["# Canary Migration Report", ""]
        if self.dry_run:
            lines += ["> **Dry run** — no files were written. Re-run with `--apply` to migrate.", ""]

        lines += [
            f"**Framework:** {self.framework}",
            f"**Shape:** {self.shape}",
        ]

        if self.detection_source and self.detection_source not in ("none", ""):
            confidence_label = {
                "config":   "high — dedicated config file",
                "content":  "medium — file content / dependency scan",
                "language": "low — harness.config.json language fallback",
            }.get(self.detection_confidence, self.detection_confidence)
            lines += [
                f"**Detected from:** `{self.detection_source}`",
                f"**Confidence:** {confidence_label}",
            ]

        lines.append("")

        if self.dry_run:
            if self.preserved_files:
                lines += ["## Existing Tests (will be preserved)", ""]
                for f in self.preserved_files:
                    lines.append(f"- `{f}`")
                lines.append("")

            if self.would_create:
                lines += ["## Would Create", ""]
                for f in self.would_create:
                    lines.append(f"- `{f}`")
                lines.append("")
            else:
                lines += ["## Would Create", "", "_Nothing new — project already has all Canary config files._", ""]

            if self.skipped_configs:
                lines += ["## Already Present (will not be touched)", ""]
                for f in self.skipped_configs:
                    lines.append(f"- `{f}`")
                lines.append("")

        else:
            if self.created_files:
                lines += ["## Created Files", ""]
                for f in self.created_files:
                    lines.append(f"- `{f}`")
                lines.append("")

            if self.created_dirs:
                lines += ["## Created Directories", ""]
                for d in self.created_dirs:
                    lines.append(f"- `{d}/`")
                lines.append("")

            if self.skipped_configs:
                lines += ["## Skipped (already exist)", ""]
                for f in self.skipped_configs:
                    lines.append(f"- `{f}` — preserved as-is")
                lines.append("")

            if self.preserved_files:
                lines += ["## Existing Tests Preserved", ""]
                for f in self.preserved_files:
                    lines.append(f"- `{f}`")
                lines.append("")

        if self.deployed_skills:
            copied = [r for r in self.deployed_skills if r.status in ("copied", "dry_run")]
            skipped = [r for r in self.deployed_skills if r.status == "skipped"]
            section = "## Skills (would deploy)" if self.dry_run else "## Skills Deployed"
            lines += [section, ""]
            for r in copied:
                prefix = "(dry run) " if r.status == "dry_run" else ""
                lines.append(f"- `{r.skill_name}` — {prefix}copied to `.canary/skills/`")
            for r in skipped:
                lines.append(f"- `{r.skill_name}` — skipped ({r.note})")
            lines.append("")

        if self.manual_followups:
            lines += ["## Manual Follow-ups Required", ""]
            for item in self.manual_followups:
                lines.append(f"- {item}")
            lines.append("")
        else:
            lines += ["## Status", "", "Migration complete. Run `canary recommend \"<test description>\"` to verify framework detection.", ""]

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Migrator
# ---------------------------------------------------------------------------

class HarnessMigrator:
    """Detects harness test-suite projects and migrates them to Canary's layout."""

    def detect(self, project_root: Path) -> MigrationContext:
        has_config = (project_root / "harness.config.json").exists()
        has_harness_dir = (project_root / ".harness").is_dir()
        is_harness = has_config and has_harness_dir

        if not is_harness:
            return MigrationContext(
                project_root=project_root,
                is_harness_project=False,
            )

        harness_config = self._load_harness_config(project_root)
        framework, shape, source, confidence = self._detect_framework(project_root, harness_config)

        return MigrationContext(
            project_root=project_root,
            is_harness_project=True,
            harness_config=harness_config,
            detected_framework=framework,
            detected_shape=shape,
            detection_source=source,
            detection_confidence=confidence,
        )

    def migrate(
        self,
        project_root: Path,
        *,
        dry_run: bool = True,
        framework: Optional[str] = None,
        overlay_path: Optional[Path] = None,
    ) -> MigrationReport:
        ctx = self.detect(project_root)
        if not ctx.is_harness_project:
            raise ValueError(
                f"No harness project detected at {project_root}. "
                "Expected harness.config.json and .harness/ directory."
            )

        effective_framework = framework or ctx.detected_framework
        shape = ctx.detected_shape
        source = "CLI override" if framework else ctx.detection_source
        confidence = "config" if framework else ctx.detection_confidence
        followups = []

        if effective_framework is None:
            followups.append(
                "Could not auto-detect framework. Run `canary migrate --framework <name>` "
                "with one of: playwright, vitest, pytest, k6, wdio."
            )
            return MigrationReport(
                framework="unknown",
                shape=shape,
                dry_run=dry_run,
                detection_source=source,
                detection_confidence=confidence,
                manual_followups=followups,
            )

        preserved = self._find_existing_tests(project_root)
        scaffolder = Scaffolder()
        deployed = self._deploy_skills(shape, overlay_path, project_root, dry_run)

        if dry_run:
            from agent.core.scaffolder import TEMPLATES
            tmpl = TEMPLATES.get(effective_framework, {})
            would_create = [
                f for f in tmpl.get("files", {})
                if not (project_root / f).exists()
            ] + [
                d for d in tmpl.get("dirs", [])
                if not (project_root / d).exists()
            ]
            already_present = [
                f for f in tmpl.get("files", {})
                if (project_root / f).exists()
            ]
            return MigrationReport(
                framework=effective_framework,
                shape=shape,
                dry_run=True,
                detection_source=source,
                detection_confidence=confidence,
                would_create=would_create,
                skipped_configs=already_present,
                preserved_files=preserved,
                manual_followups=followups,
                deployed_skills=deployed,
            )

        result = scaffolder.scaffold(effective_framework, project_root=str(project_root))

        return MigrationReport(
            framework=effective_framework,
            shape=shape,
            dry_run=False,
            detection_source=source,
            detection_confidence=confidence,
            created_files=result["created_files"],
            created_dirs=result["created_dirs"],
            skipped_configs=result["skipped_files"],
            preserved_files=preserved,
            manual_followups=followups,
            deployed_skills=deployed,
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _deploy_skills(
        self,
        shape: str,
        overlay_path: Optional[Path],
        target_root: Path,
        dry_run: bool,
    ) -> list[SkillDeployResult]:
        """Copy skills from *overlay_path*/.canary/skills/ that match *shape*.

        A skill is deployed when its ``deploy_to`` frontmatter list includes
        the detected shape or the sentinel value ``all``. Skills already
        present in the target are skipped (not overwritten).

        When *overlay_path* is None and ``~/.canary/skills/`` does not exist,
        returns an empty list silently.
        """
        from agent.core.skill_registry import SkillRegistry

        results: list[SkillDeployResult] = []

        # Collect overlay skill directories to inspect.
        candidate_roots: list[Path] = []
        if overlay_path is not None:
            candidate_roots.append(overlay_path)
        home_skills = Path.home() / ".canary" / "skills"
        if home_skills.is_dir():
            candidate_roots.append(home_skills.parent.parent)  # registry walks up

        skills_to_deploy: list = []
        seen_names: set[str] = set()

        for root in candidate_roots:
            overlay_skills_dir = root / ".canary" / "skills"
            if not overlay_skills_dir.is_dir():
                # Maybe root IS the .canary/skills dir directly
                if root.name == "skills" and (root / "..").resolve().name == ".canary":
                    overlay_skills_dir = root
                else:
                    continue
            for skill_dir in sorted(overlay_skills_dir.iterdir()):
                if not skill_dir.is_dir():
                    continue
                skill_md = skill_dir / "SKILL.md"
                if not skill_md.exists():
                    continue
                # Parse frontmatter directly to avoid full registry overhead.
                reg = SkillRegistry()
                info = reg._parse_nested(skill_md, skill_dir.name, "overlay")
                if info is None or info.name in seen_names:
                    continue
                if not info.deploy_to:
                    continue
                if shape not in info.deploy_to and "all" not in info.deploy_to:
                    continue
                seen_names.add(info.name)
                skills_to_deploy.append((info, skill_dir))

        target_skills_dir = target_root / ".canary" / "skills"

        for info, skill_dir in skills_to_deploy:
            dest = target_skills_dir / skill_dir.name
            if dest.exists():
                results.append(SkillDeployResult(
                    skill_name=info.name,
                    status="skipped",
                    note="already present",
                ))
                continue
            if dry_run:
                results.append(SkillDeployResult(
                    skill_name=info.name,
                    status="dry_run",
                ))
                continue
            import shutil
            target_skills_dir.mkdir(parents=True, exist_ok=True)
            shutil.copytree(skill_dir, dest)
            results.append(SkillDeployResult(skill_name=info.name, status="copied"))

        return results

    def _load_harness_config(self, root: Path) -> dict:
        try:
            return json.loads((root / "harness.config.json").read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _detect_framework(
        self, root: Path, config: dict
    ) -> tuple[Optional[str], str, str, str]:
        """Return (framework, shape, source, confidence)."""

        # 1. Dedicated config file (highest confidence)
        for filename, framework, shape, confidence in _CONFIG_PROBES:
            if (root / filename).exists():
                return framework, shape, filename, confidence

        # 2. pyproject.toml section markers then dependency scan
        pyproject = root / "pyproject.toml"
        if pyproject.exists():
            try:
                content = pyproject.read_text()
                for marker, framework, shape in _PYPROJECT_MARKERS:
                    if marker in content:
                        return framework, shape, "pyproject.toml", "content"
                for pattern, framework, shape in _PYTHON_DEP_PATTERNS:
                    if pattern.search(content):
                        return framework, shape, "pyproject.toml (dependencies)", "content"
            except OSError:
                pass

        # 3. requirements*.txt dependency scan
        for req_file in ("requirements.txt", "requirements-test.txt", "requirements-dev.txt"):
            req_path = root / req_file
            if req_path.exists():
                try:
                    content = req_path.read_text()
                    for pattern, framework, shape in _PYTHON_DEP_PATTERNS:
                        if pattern.search(content):
                            return framework, shape, req_file, "content"
                except OSError:
                    pass

        # 4. package.json scripts.test scan
        pkg_json = root / "package.json"
        if pkg_json.exists():
            try:
                pkg = json.loads(pkg_json.read_text())
                test_script = pkg.get("scripts", {}).get("test", "")
                for pattern, framework, shape in _PACKAGE_SCRIPT_PATTERNS:
                    if pattern.search(test_script):
                        return framework, shape, "package.json (scripts.test)", "content"
            except (OSError, json.JSONDecodeError):
                pass

        # 5. Language fallback from harness config
        language = config.get("language", "").lower()
        if language in _LANGUAGE_FALLBACKS:
            fw, shape = _LANGUAGE_FALLBACKS[language]
            return fw, shape, f"harness.config.json (language: {language})", "language"

        return None, "unknown", "none", "none"

    def _find_existing_tests(self, root: Path) -> list[str]:
        found = []
        for pattern in _TEST_GLOBS:
            for path in sorted(root.glob(pattern)):
                rel = str(path.relative_to(root))
                if rel not in found:
                    found.append(rel)
        return found
