# agent/core/migrator.py

"""
Oracle Migrator — detects harness-scaffolded test-suite projects and migrates
them to Oracle's layout without touching existing test files.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from agent.core.scaffolder import Scaffolder

# Ordered probe list: (config_file, framework, shape)
_CONFIG_PROBES = [
    ("playwright.config.ts",  "playwright", "e2e_ui"),
    ("playwright.config.js",  "playwright", "e2e_ui"),
    ("vitest.config.ts",      "vitest",     "frontend_unit"),
    ("vitest.config.js",      "vitest",     "frontend_unit"),
    ("k6.config.js",          "k6",         "performance"),
    ("pytest.ini",            "pytest",     "api"),
]

# pyproject.toml needs content inspection
_PYPROJECT_PYTEST_MARKER = "[tool.pytest.ini_options]"

# Language → (framework, shape) fallbacks when no config file is found
_LANGUAGE_FALLBACKS = {
    "python":     ("pytest",     "api"),
    "typescript": ("playwright", "e2e_ui"),
    "javascript": ("playwright", "e2e_ui"),
}

# Glob patterns that identify existing test files to preserve
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


@dataclass
class MigrationContext:
    project_root: Path
    is_harness_project: bool
    harness_config: dict = field(default_factory=dict)
    detected_framework: Optional[str] = None
    detected_shape: str = "unknown"


@dataclass
class MigrationReport:
    framework: str
    shape: str
    dry_run: bool
    created_files: list = field(default_factory=list)
    created_dirs: list = field(default_factory=list)
    skipped_configs: list = field(default_factory=list)
    preserved_files: list = field(default_factory=list)
    would_create: list = field(default_factory=list)
    manual_followups: list = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = ["# Oracle Migration Report", ""]
        if self.dry_run:
            lines += ["> **Dry run** — no files were written. Re-run with `--apply` to migrate.", ""]

        lines += [
            f"**Framework:** {self.framework}",
            f"**Shape:** {self.shape}",
            "",
        ]

        if self.dry_run and self.would_create:
            lines += ["## Would Create", ""]
            for f in self.would_create:
                lines.append(f"- `{f}`")
            lines.append("")

        if not self.dry_run and self.created_files:
            lines += ["## Created Files", ""]
            for f in self.created_files:
                lines.append(f"- `{f}`")
            lines.append("")

        if not self.dry_run and self.created_dirs:
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

        if self.manual_followups:
            lines += ["## Manual Follow-ups Required", ""]
            for item in self.manual_followups:
                lines.append(f"- {item}")
            lines.append("")

        if not self.manual_followups:
            lines += ["## Status", "", "Migration complete. Run `oracle generate --recommend-only` to verify.", ""]

        return "\n".join(lines)


class HarnessMigrator:
    """Detects harness test-suite projects and migrates them to Oracle's layout."""

    def detect(self, project_root: Path) -> MigrationContext:
        """Inspect project_root for harness markers and auto-detect framework."""
        has_config = (project_root / "harness.config.json").exists()
        has_harness_dir = (project_root / ".harness").is_dir()
        is_harness = has_config and has_harness_dir

        if not is_harness:
            return MigrationContext(
                project_root=project_root,
                is_harness_project=False,
            )

        harness_config = self._load_harness_config(project_root)
        framework, shape = self._detect_framework(project_root, harness_config)

        return MigrationContext(
            project_root=project_root,
            is_harness_project=True,
            harness_config=harness_config,
            detected_framework=framework,
            detected_shape=shape,
        )

    def migrate(
        self,
        project_root: Path,
        *,
        dry_run: bool = True,
        framework: Optional[str] = None,
    ) -> MigrationReport:
        """
        Migrate a harness-scaffolded project to Oracle's layout.

        Args:
            project_root: Root directory of the project to migrate.
            dry_run: When True (default), report what would change without writing anything.
            framework: Override auto-detected framework (e.g. from --framework CLI flag).

        Raises:
            ValueError: If the project is not a harness-scaffolded project.
        """
        ctx = self.detect(project_root)
        if not ctx.is_harness_project:
            raise ValueError(
                f"No harness project detected at {project_root}. "
                "Expected harness.config.json and .harness/ directory."
            )

        framework = framework or ctx.detected_framework
        shape = ctx.detected_shape
        followups = []

        if framework is None:
            followups.append(
                "Could not auto-detect framework. Run `oracle migrate --framework <name>` "
                "with one of: playwright, vitest, pytest, k6."
            )
            return MigrationReport(
                framework="unknown",
                shape=shape,
                dry_run=dry_run,
                manual_followups=followups,
            )

        preserved = self._find_existing_tests(project_root)
        scaffolder = Scaffolder()

        if dry_run:
            # Simulate what scaffold would create
            from agent.core.scaffolder import TEMPLATES
            tmpl = TEMPLATES.get(framework, {})
            would_create = [
                f for f in tmpl.get("files", {})
                if not (project_root / f).exists()
            ] + [
                d for d in tmpl.get("dirs", [])
                if not (project_root / d).exists()
            ]
            return MigrationReport(
                framework=framework,
                shape=shape,
                dry_run=True,
                would_create=would_create,
                preserved_files=preserved,
                manual_followups=followups,
            )

        result = scaffolder.scaffold(framework, project_root=str(project_root))

        return MigrationReport(
            framework=framework,
            shape=shape,
            dry_run=False,
            created_files=result["created_files"],
            created_dirs=result["created_dirs"],
            skipped_configs=result["skipped_files"],
            preserved_files=preserved,
            manual_followups=followups,
        )

    # ── private helpers ───────────────────────────────────────────────────

    def _load_harness_config(self, root: Path) -> dict:
        try:
            return json.loads((root / "harness.config.json").read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _detect_framework(self, root: Path, config: dict) -> tuple[Optional[str], str]:
        # 1. Config file probes (highest confidence)
        for filename, framework, shape in _CONFIG_PROBES:
            if (root / filename).exists():
                return framework, shape

        # 2. pyproject.toml with pytest section
        pyproject = root / "pyproject.toml"
        if pyproject.exists():
            try:
                if _PYPROJECT_PYTEST_MARKER in pyproject.read_text():
                    return "pytest", "api"
            except OSError:
                pass

        # 3. Language fallback from harness config
        language = config.get("language", "").lower()
        if language in _LANGUAGE_FALLBACKS:
            return _LANGUAGE_FALLBACKS[language]

        return None, "unknown"

    def _find_existing_tests(self, root: Path) -> list[str]:
        found = []
        for pattern in _TEST_GLOBS:
            for path in sorted(root.glob(pattern)):
                rel = str(path.relative_to(root))
                if rel not in found:
                    found.append(rel)
        return found
