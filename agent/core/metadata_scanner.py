# agent/core/metadata_scanner.py

"""Project metadata scanner for Canary.

Scans the user's project root for package.json, tsconfig.json,
requirements.txt, and pyproject.toml, then surfaces dependency
versions so the generation prompt can reference exact library versions.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Any, Set


@dataclass
class ProjectMetadata:
    """Detected dependency and config metadata for a project."""

    js_dependencies: Dict[str, str] = field(default_factory=dict)
    python_packages: Dict[str, str] = field(default_factory=dict)
    tsconfig: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.js_dependencies and not self.python_packages and not self.tsconfig

    @property
    def detected_languages(self) -> Set[str]:
        """Infer project languages from detected metadata."""
        langs: Set[str] = set()
        if self.js_dependencies:
            langs.update({"typescript", "javascript"})
        if self.tsconfig:
            langs.add("typescript")
        if self.python_packages:
            langs.add("python")
        return langs


class MetadataScanner:
    """Scans a project root and returns its dependency metadata."""

    def scan(self, project_root: str = ".") -> ProjectMetadata:
        """
        Scan project_root for known metadata files.

        Args:
            project_root: Directory to scan. Defaults to cwd.

        Returns:
            ProjectMetadata populated from whatever files are found.
            Missing files are silently skipped.
        """
        root = Path(project_root).resolve()
        metadata = ProjectMetadata()

        self._read_package_json(root, metadata)
        self._read_requirements_txt(root, metadata)
        if not metadata.python_packages:
            self._read_pyproject_toml(root, metadata)
        self._read_tsconfig(root, metadata)

        return metadata

    def _read_package_json(self, root: Path, metadata: ProjectMetadata) -> None:
        path = root / "package.json"
        if not path.exists():
            return
        try:
            pkg = json.loads(path.read_text(encoding="utf-8"))
            deps: Dict[str, str] = {}
            raw_deps = pkg.get("dependencies") or {}
            raw_dev = pkg.get("devDependencies") or {}
            if isinstance(raw_deps, dict):
                deps.update(raw_deps)
            if isinstance(raw_dev, dict):
                deps.update(raw_dev)
            metadata.js_dependencies = deps
        except (json.JSONDecodeError, OSError):
            pass

    def _read_requirements_txt(self, root: Path, metadata: ProjectMetadata) -> None:
        path = root / "requirements.txt"
        if not path.exists():
            return
        try:
            metadata.python_packages = self._parse_requirements(
                path.read_text(encoding="utf-8")
            )
        except OSError:
            pass

    def _read_pyproject_toml(self, root: Path, metadata: ProjectMetadata) -> None:
        path = root / "pyproject.toml"
        if not path.exists():
            return
        try:
            text = path.read_text(encoding="utf-8")
            metadata.python_packages = self._parse_pyproject_deps(text)
        except OSError:
            pass

    def _read_tsconfig(self, root: Path, metadata: ProjectMetadata) -> None:
        path = root / "tsconfig.json"
        if not path.exists():
            return
        try:
            tsconfig = json.loads(path.read_text(encoding="utf-8"))
            metadata.tsconfig = tsconfig.get("compilerOptions", {})
        except (json.JSONDecodeError, OSError):
            pass

    def _parse_requirements(self, text: str) -> Dict[str, str]:
        packages: Dict[str, str] = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            for sep in ("==", ">=", "<=", "~=", "!=", ">", "<"):
                if sep in line:
                    name, version = line.split(sep, 1)
                    packages[name.strip()] = sep + version.strip()
                    break
            else:
                packages[line] = ""
        return packages

    def _parse_pyproject_deps(self, text: str) -> Dict[str, str]:
        # Isolate the [project] section first, stopping at the next section
        # header, so we never read dependencies from [tool.*] or other sections.
        section = re.search(
            r"^\[project\]$(.*?)(?=^\[|\Z)",
            text,
            re.MULTILINE | re.DOTALL,
        )
        if not section:
            return {}
        match = re.search(
            r"^dependencies\s*=\s*\[(.*?)\]",
            section.group(1),
            re.MULTILINE | re.DOTALL,
        )
        if not match:
            return {}
        packages: Dict[str, str] = {}
        for dep_str in re.findall(r'"([^"]+)"', match.group(1)):
            for sep in ("==", ">=", "<=", "~=", "!=", ">", "<"):
                if sep in dep_str:
                    name, ver = dep_str.split(sep, 1)
                    packages[name.strip()] = sep + ver.strip()
                    break
            else:
                if dep_str.strip():
                    packages[dep_str.strip()] = ""
        return packages
