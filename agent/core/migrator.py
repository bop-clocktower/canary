# agent/core/migrator.py

from __future__ import annotations

"""
Canary Migrator — detects harness-scaffolded test-suite projects and migrates
them to Canary's layout without touching existing test files.
"""

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Records the content hash of each skill at deploy time so the freshness gate can
# tell an untouched deployment (safe to refresh) from a hand-edited one (must not
# be overwritten). Lives beside the deployed skills; never a deployable skill
# itself (leading dot → skipped by the skill scanner).
DEPLOY_MANIFEST_NAME = ".deploy-manifest.json"


def _hash_skill_dir(skill_dir: Path) -> str:
    """Return a stable content hash of every file under *skill_dir*.

    Hashes the sorted (relative-path, bytes) pairs so any change to any file in
    the skill — not just SKILL.md — counts as a change. The deployable unit is
    the whole directory, matching how ``_deploy_skills`` copies it.
    """
    h = hashlib.sha256()
    for path in sorted(p for p in skill_dir.rglob("*") if p.is_file()):
        h.update(path.relative_to(skill_dir).as_posix().encode("utf-8"))
        h.update(b"\0")
        try:
            h.update(path.read_bytes())
        except OSError:
            pass
        h.update(b"\0")
    return h.hexdigest()


def _read_deploy_manifest(target_skills_dir: Path) -> dict:
    """Return ``{dir_name: {"name": str, "hash": str}}`` from the manifest, or
    ``{}`` when it is absent or unreadable (provenance is best-effort)."""
    manifest_path = target_skills_dir / DEPLOY_MANIFEST_NAME
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    skills = data.get("skills") if isinstance(data, dict) else None
    return skills if isinstance(skills, dict) else {}


def _write_deploy_manifest(target_skills_dir: Path, skills: dict) -> None:
    manifest_path = target_skills_dir / DEPLOY_MANIFEST_NAME
    target_skills_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps({"schemaVersion": 1, "skills": skills}, indent=2) + "\n",
        encoding="utf-8",
    )

from agent.core.config_validation import read_json_with_warning
from agent.core.detection import uncertain_detection_message
from agent.core.scaffolder import Scaffolder

# Frameworks a user can pass to `canary migrate --framework <name>`. Surfaced
# in the fail-loud message when auto-detection is uncertain (issue #295).
KNOWN_FRAMEWORKS = ("playwright", "vitest", "pytest", "k6", "wdio", "locust")

# Layer names that mark a skills/docs *overlay* rather than a test suite. Used
# by the non-test-repo guard (#319 C): an overlay ships harness.config.json +
# .harness/ (so it looks migratable) but declares no test entry points and only
# these documentation/skills layers.
_DOC_SKILL_LAYER_NAMES = frozenset(
    {"skills", "docs", "guides", "agents", "overlays", "commands", "prompts"}
)


def _skills_docs_overlay_reason(config: dict) -> Optional[str]:
    """Return a human reason when `config` describes a skills/docs overlay
    (not a migratable test suite), else None.

    Conservative by design — fires only on a *clear* overlay signal so a real
    test suite is never blocked: no test ``entryPoints`` AND at least one
    declared layer, with every declared layer being a docs/skills layer. A
    project with any code/test layer, or with entry points, is left alone.
    """
    if config.get("entryPoints"):
        return None
    layers = config.get("layers") or []
    names = {
        (layer.get("name") or "").lower()
        for layer in layers
        if isinstance(layer, dict)
    }
    names.discard("")
    if not names or not names <= _DOC_SKILL_LAYER_NAMES:
        return None
    return (
        "harness.config.json and .harness/ are present, but this looks like a "
        "skills/docs overlay (no test entryPoints; layers are only "
        f"{', '.join(sorted(names))}), not a test suite. `canary migrate` "
        "scaffolds a test suite and has nothing to migrate here."
    )


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

# Detects playwright UI fixture params — `async ({ page,` / `async ({browser,` etc.
# Matches fixture destructuring specifically (inside an async arrow function param)
# to avoid false positives from variable names or comments.
_PW_UI_FIXTURE_RE = re.compile(
    r"async\s*\(\s*\{[^}]*\b(?:page|browser)\b",
    re.MULTILINE,
)


def _infer_playwright_shape(root: Path) -> str:
    """Return 'api' when no playwright spec file uses page/browser fixtures.

    UI suites always reference ``page`` or ``browser`` in at least one test's
    async fixture params. API suites never do — they use ``request`` or custom
    wrappers. If we scan all spec files and find zero UI fixture usage, the
    suite is API-shaped.

    Returns 'e2e_ui' (the default) when any UI signal is found or no spec
    files exist.
    """
    spec_globs = [
        "tests/**/*.spec.ts", "tests/**/*.spec.js",
        "test/**/*.spec.ts",  "test/**/*.spec.js",
    ]
    total = 0
    for glob in spec_globs:
        for path in root.glob(glob):
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            total += 1
            if _PW_UI_FIXTURE_RE.search(content):
                return "e2e_ui"

    return "api" if total > 0 else "e2e_ui"


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
    config_warnings: list = field(default_factory=list)
    # When a repo HAS harness.config.json + .harness/ but is not a migratable
    # test suite (e.g. a skills/docs overlay), this carries the human reason so
    # callers can say "not a test project" instead of "no config". (#319 C)
    not_test_project_reason: Optional[str] = None


@dataclass
class SkillDeployResult:
    skill_name: str
    status: str   # "copied" | "updated" | "skipped" | "dry_run"
    note: str = ""


@dataclass
class SkillFreshnessResult:
    skill_name: str
    dir_name: str
    # "current"    — deployed copy matches the overlay
    # "stale"      — overlay has a newer version; deployed copy untouched (safe to refresh)
    # "missing"    — overlay ships a matching skill the target does not carry
    # "local_edit" — deployed copy differs from the overlay AND from what was deployed
    #                (or has no provenance); one-way ownership refuses to overwrite it
    status: str
    detail: str = ""


@dataclass
class FreshnessReport:
    """Result of `canary migrate --check` — how a target's deployed overlay
    skills compare to the overlay that owns them."""

    shape: str
    overlay_path: Optional[str] = None
    results: list[SkillFreshnessResult] = field(default_factory=list)

    @property
    def stale(self) -> list[SkillFreshnessResult]:
        return [r for r in self.results if r.status in ("stale", "missing")]

    @property
    def local_edits(self) -> list[SkillFreshnessResult]:
        return [r for r in self.results if r.status == "local_edit"]

    @property
    def has_drift(self) -> bool:
        return bool(self.stale)

    @property
    def has_local_edits(self) -> bool:
        return bool(self.local_edits)

    @property
    def in_sync(self) -> bool:
        return not self.has_drift and not self.has_local_edits

    def exit_code(self) -> int:
        """0 in sync · 1 drift · 2 local edits (safety refusal wins)."""
        if self.has_local_edits:
            return 2
        if self.has_drift:
            return 1
        return 0

    def to_dict(self) -> dict:
        return {
            "shape": self.shape,
            "overlay_path": self.overlay_path,
            "in_sync": self.in_sync,
            "has_drift": self.has_drift,
            "has_local_edits": self.has_local_edits,
            "exit_code": self.exit_code(),
            "skills": [
                {"skill_name": r.skill_name, "dir_name": r.dir_name,
                 "status": r.status, "detail": r.detail}
                for r in self.results
            ],
        }

    def to_markdown(self) -> str:
        lines = ["# Overlay Freshness", "", f"**Shape:** {self.shape}", ""]
        if not self.results:
            lines += ["_No overlay skills match this project's shape._", ""]
            return "\n".join(lines)

        if self.in_sync:
            lines += ["✅ In sync — every deployed overlay skill is current.", ""]

        stale = [r for r in self.results if r.status == "stale"]
        missing = [r for r in self.results if r.status == "missing"]
        edits = self.local_edits

        if missing:
            lines += ["## Missing (overlay ships, target does not carry)", ""]
            lines += [f"- `{r.skill_name}`" for r in missing] + [""]
        if stale:
            lines += ["## Stale (overlay has a newer version)", ""]
            lines += [f"- `{r.skill_name}` — {r.detail}" for r in stale] + [""]
        if edits:
            lines += ["## ⚠ Local edits (refused — one-way ownership)", ""]
            lines += [f"- `{r.skill_name}` — {r.detail}" for r in edits] + [""]

        if self.has_drift and not self.has_local_edits:
            lines += ["Run `canary migrate --from <overlay> --apply` to refresh.", ""]
        elif self.has_local_edits:
            lines += [
                "Deployed skills are owned by the overlay. Reconcile the local "
                "edits above (revert them, or upstream them into the overlay) "
                "before the freshness gate can pass.",
                "",
            ]
        return "\n".join(lines)


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
    config_warnings: list = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = ["# Canary Migration Report", ""]
        if self.dry_run:
            lines += ["> **Dry run** — no files were written. Re-run with `--apply` to migrate.", ""]

        if self.config_warnings:
            lines += ["## ⚠ Config Warnings", ""]
            for w in self.config_warnings:
                lines.append(f"- {w}")
            lines.append("")

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
            copied = [r for r in self.deployed_skills if r.status in ("copied", "dry_run", "updated")]
            skipped = [r for r in self.deployed_skills if r.status == "skipped"]
            section = "## Skills (would deploy)" if self.dry_run else "## Skills Deployed"
            lines += [section, ""]
            for r in copied:
                prefix = "(dry run) " if r.status == "dry_run" else ""
                verb = "refreshed in" if r.status == "updated" else "copied to"
                lines.append(f"- `{r.skill_name}` — {prefix}{verb} `.canary/skills/`")
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

        config_warnings: list[str] = []

        harness_config, warning = read_json_with_warning(project_root / "harness.config.json")
        if warning:
            config_warnings.append(warning)
        harness_config = harness_config or {}

        # Merge canary_shape from .canary/company.json into the config dict so
        # _detect_framework can honour an explicit shape override. A malformed
        # company.json warns (the file exists — this is a real config
        # problem) but never blocks detection; it just contributes no override.
        canary_company = project_root / ".canary" / "company.json"
        overlay, warning = read_json_with_warning(canary_company)
        if warning:
            config_warnings.append(warning)
        if overlay and "canary_shape" in overlay:
            harness_config = {**harness_config, "canary_shape": overlay["canary_shape"]}

        # #319 C: a skills/docs overlay has harness.config.json + .harness/ too,
        # but is not a migratable test suite. Refuse it here with a distinct
        # reason so callers don't scaffold a suite into it or mislabel the
        # refusal as "no config found".
        overlay_reason = _skills_docs_overlay_reason(harness_config)
        if overlay_reason:
            return MigrationContext(
                project_root=project_root,
                is_harness_project=False,
                harness_config=harness_config,
                config_warnings=config_warnings,
                not_test_project_reason=overlay_reason,
            )

        framework, shape, source, confidence = self._detect_framework(project_root, harness_config)

        return MigrationContext(
            project_root=project_root,
            is_harness_project=True,
            harness_config=harness_config,
            detected_framework=framework,
            detected_shape=shape,
            detection_source=source,
            detection_confidence=confidence,
            config_warnings=config_warnings,
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
            if ctx.not_test_project_reason:
                raise ValueError(ctx.not_test_project_reason)
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
                uncertain_detection_message(
                    "test framework",
                    reason="no config file, dependency, or language marker matched a known framework",
                    candidates=KNOWN_FRAMEWORKS,
                    override_hint="`canary migrate --framework <name>`",
                )
            )
            # Issue #295 point 3: a detection miss must not block skill
            # deployment. deploy_to:[all] skills are framework-agnostic, so
            # deploy them even with an unknown shape rather than deploying
            # nothing. (Shape-specific skills still can't match an unknown
            # shape, which is correct — we don't know which to pick.)
            deployed = self._deploy_skills(shape, overlay_path, project_root, dry_run)
            return MigrationReport(
                framework="unknown",
                shape=shape,
                dry_run=dry_run,
                detection_source=source,
                detection_confidence=confidence,
                manual_followups=followups,
                config_warnings=ctx.config_warnings,
                deployed_skills=deployed,
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
                config_warnings=ctx.config_warnings,
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
            config_warnings=ctx.config_warnings,
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _collect_overlay_skills(
        self, shape: str, overlay_path: Optional[Path]
    ) -> list:
        """Return ``[(SkillInfo, skill_dir), …]`` for overlay skills whose
        ``deploy_to`` matches *shape* (or the ``all`` sentinel).

        Sources: *overlay_path* first, then ``~/.canary/skills/`` if present.
        The first definition of a given skill name wins (overlay before home).
        """
        from agent.core.skill_registry import SkillRegistry

        candidate_roots: list[Path] = []
        if overlay_path is not None:
            candidate_roots.append(overlay_path)
        home_skills = Path.home() / ".canary" / "skills"
        if home_skills.is_dir():
            candidate_roots.append(home_skills.parent.parent)  # registry walks up

        collected: list = []
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
                collected.append((info, skill_dir))

        return collected

    def _deploy_skills(
        self,
        shape: str,
        overlay_path: Optional[Path],
        target_root: Path,
        dry_run: bool,
    ) -> list[SkillDeployResult]:
        """Copy skills from *overlay_path*/.canary/skills/ that match *shape*.

        A skill is deployed when its ``deploy_to`` frontmatter list includes the
        detected shape or the sentinel value ``all``. Deployment is strictly
        one-way — the overlay owns deployed files (#334):

        - missing in target → copied.
        - present and identical to the overlay → skipped (already current).
        - present, differs from the overlay, but still matches what we last
          deployed (deploy manifest) → **updated** (refreshed from the overlay).
        - present, differs from both the overlay and the last deployment, or has
          no provenance → **skipped** with a local-edit note; never overwritten.

        When *overlay_path* is None and ``~/.canary/skills/`` does not exist,
        returns an empty list silently.
        """
        import shutil

        results: list[SkillDeployResult] = []
        skills_to_deploy = self._collect_overlay_skills(shape, overlay_path)

        target_skills_dir = target_root / ".canary" / "skills"
        manifest = _read_deploy_manifest(target_skills_dir)
        manifest_dirty = False

        for info, skill_dir in skills_to_deploy:
            dest = target_skills_dir / skill_dir.name
            overlay_hash = _hash_skill_dir(skill_dir)

            if dest.exists():
                target_hash = _hash_skill_dir(dest)
                if target_hash == overlay_hash:
                    results.append(SkillDeployResult(
                        skill_name=info.name, status="skipped", note="already current"
                    ))
                    if manifest.get(skill_dir.name, {}).get("hash") != overlay_hash:
                        manifest[skill_dir.name] = {"name": info.name, "hash": overlay_hash}
                        manifest_dirty = True
                    continue
                recorded = manifest.get(skill_dir.name, {}).get("hash")
                if recorded is None or target_hash != recorded:
                    # Hand-edited (or unprovenanced) — one-way ownership refuses
                    # to clobber it.
                    results.append(SkillDeployResult(
                        skill_name=info.name, status="skipped",
                        note="local edits — not overwritten",
                    ))
                    continue
                # Untouched since deploy; overlay moved on → safe to refresh.
                if dry_run:
                    results.append(SkillDeployResult(
                        skill_name=info.name, status="dry_run", note="would update"
                    ))
                    continue
                shutil.rmtree(dest)
                shutil.copytree(skill_dir, dest)
                manifest[skill_dir.name] = {"name": info.name, "hash": overlay_hash}
                manifest_dirty = True
                results.append(SkillDeployResult(skill_name=info.name, status="updated"))
                continue

            if dry_run:
                results.append(SkillDeployResult(skill_name=info.name, status="dry_run"))
                continue
            target_skills_dir.mkdir(parents=True, exist_ok=True)
            shutil.copytree(skill_dir, dest)
            manifest[skill_dir.name] = {"name": info.name, "hash": overlay_hash}
            manifest_dirty = True
            results.append(SkillDeployResult(skill_name=info.name, status="copied"))

        if manifest_dirty and not dry_run:
            _write_deploy_manifest(target_skills_dir, manifest)

        return results

    def check_freshness(
        self,
        project_root: Path,
        *,
        overlay_path: Optional[Path],
        framework: Optional[str] = None,
    ) -> FreshnessReport:
        """Compare the overlay's deployable skills against what *project_root*
        carries, without writing anything (#334).

        Classifies each matching overlay skill as current / stale / missing /
        local_edit. Drift (stale + missing) means the overlay has newer
        deployable skills the target should refresh; a local edit is a
        one-way-ownership safety stop that must be reconciled by hand.
        """
        ctx = self.detect(project_root)
        if not ctx.is_harness_project:
            if ctx.not_test_project_reason:
                raise ValueError(ctx.not_test_project_reason)
            raise ValueError(
                f"No harness project detected at {project_root}. "
                "Expected harness.config.json and .harness/ directory."
            )

        shape = ctx.detected_shape
        skills = self._collect_overlay_skills(shape, overlay_path)
        target_skills_dir = project_root / ".canary" / "skills"
        manifest = _read_deploy_manifest(target_skills_dir)

        results: list[SkillFreshnessResult] = []
        for info, skill_dir in skills:
            dest = target_skills_dir / skill_dir.name
            if not dest.exists():
                results.append(SkillFreshnessResult(
                    info.name, skill_dir.name, "missing",
                    "overlay ships this skill; target does not carry it",
                ))
                continue
            overlay_hash = _hash_skill_dir(skill_dir)
            target_hash = _hash_skill_dir(dest)
            if target_hash == overlay_hash:
                results.append(SkillFreshnessResult(info.name, skill_dir.name, "current"))
                continue
            recorded = manifest.get(skill_dir.name, {}).get("hash")
            if recorded is not None and target_hash == recorded:
                results.append(SkillFreshnessResult(
                    info.name, skill_dir.name, "stale",
                    "overlay has a newer version",
                ))
            else:
                results.append(SkillFreshnessResult(
                    info.name, skill_dir.name, "local_edit",
                    "deployed skill has local edits; refusing to overwrite",
                ))

        return FreshnessReport(
            shape=shape,
            overlay_path=str(overlay_path) if overlay_path is not None else None,
            results=results,
        )

    def _detect_framework(
        self, root: Path, config: dict
    ) -> tuple[Optional[str], str, str, str]:
        """Return (framework, shape, source, confidence)."""

        # 0. Explicit override in .canary/company.json ("canary_shape" field)
        explicit_shape = config.get("canary_shape", "").strip().lower()
        if explicit_shape:
            # Still detect the framework via normal probes, but honour the shape.
            for filename, framework, _shape, confidence in _CONFIG_PROBES:
                if (root / filename).exists():
                    return framework, explicit_shape, filename, confidence
            # Fall through to content probes; shape override still applies below.

        # 1. Dedicated config file (highest confidence)
        for filename, framework, shape, confidence in _CONFIG_PROBES:
            if (root / filename).exists():
                # For playwright config files, run a secondary heuristic to
                # distinguish API suites (request fixture) from UI suites (page).
                if framework == "playwright" and shape == "e2e_ui":
                    inferred = _infer_playwright_shape(root)
                    if inferred != shape:
                        return framework, inferred, filename, "content"
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
