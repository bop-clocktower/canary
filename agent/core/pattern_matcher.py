# agent/core/pattern_matcher.py

"""Pattern matcher for Oracle.

Scans existing test files in the user's project and extracts coding
conventions — naming style, common imports, assertion style, and
structural patterns — so generated tests match what the project already
uses.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import List


# Glob patterns keyed by framework name or test_type.
_FILE_PATTERNS = {
    "playwright": ["**/*.spec.ts", "**/*.spec.js", "**/*.test.ts", "**/*.test.js"],
    "vitest":     ["**/*.test.ts", "**/*.test.js", "**/*.spec.ts", "**/*.spec.js"],
    "pytest":     ["**/test_*.py", "**/*_test.py"],
    "k6":         ["**/*.load.js", "**/load.js"],
    # fallbacks by test_type
    "e2e_ui":       ["**/*.spec.ts", "**/*.spec.js"],
    "frontend_unit": ["**/*.test.ts", "**/*.test.js"],
    "api":          ["**/test_*.py", "**/*_test.py"],
    "performance":  ["**/*.load.js"],
    "python_unit":  ["**/test_*.py", "**/*_test.py"],
}

_IGNORED_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt",
}

_MAX_FILES = 10
_MAX_FILE_BYTES = 32_768  # 32 KB — skip suspiciously large files


@dataclass
class PatternProfile:
    """Extracted coding conventions from a project's existing test suite."""

    test_count: int = 0
    language: str = ""             # "python" or "javascript"
    naming_style: str = ""         # human-readable description
    assertion_style: str = ""      # e.g. "pytest assert", "expect().toBe()"
    uses_classes: bool = False     # Python: tests grouped in classes
    uses_fixtures: bool = False    # Python: @pytest.fixture / conftest
    uses_describe: bool = False    # JS: describe() blocks present
    common_imports: List[str] = field(default_factory=list)
    sample_names: List[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return self.test_count == 0


class PatternMatcher:
    """Scans existing test files and returns a PatternProfile."""

    def scan(
        self,
        project_root: str = ".",
        framework: str = "",
        test_type: str = "",
    ) -> PatternProfile:
        """
        Scan project_root for existing test files matching the framework.

        Args:
            project_root: Directory to scan. Defaults to cwd.
            framework: Framework name (e.g. 'pytest', 'playwright').
            test_type: Classified test type as fallback key.

        Returns:
            PatternProfile with extracted conventions.
            Returns an empty profile if no test files are found.
        """
        root = Path(project_root).resolve()
        files = self._find_test_files(root, framework, test_type)
        if not files:
            return PatternProfile()

        sample = files[:_MAX_FILES]
        is_python = framework in ("pytest",) or test_type in ("api", "python_unit")

        # Detect language from file extensions when framework is ambiguous.
        if not is_python and sample:
            is_python = sample[0].suffix == ".py"

        profile = PatternProfile(
            test_count=len(files),
            language="python" if is_python else "javascript",
        )

        if is_python:
            self._analyze_python(sample, profile)
        else:
            self._analyze_js(sample, profile)

        return profile

    # ------------------------------------------------------------------
    # File discovery
    # ------------------------------------------------------------------

    def _find_test_files(
        self, root: Path, framework: str, test_type: str
    ) -> List[Path]:
        patterns = (
            _FILE_PATTERNS.get(framework)
            or _FILE_PATTERNS.get(test_type)
            or ["**/test_*.py", "**/*.spec.ts", "**/*.test.ts"]
        )
        found: List[Path] = []
        seen = set()
        for pattern in patterns:
            for path in root.glob(pattern):
                if path in seen:
                    continue
                if any(p in _IGNORED_DIRS for p in path.parts):
                    continue
                try:
                    if path.stat().st_size > _MAX_FILE_BYTES:
                        continue
                except OSError:
                    continue
                seen.add(path)
                found.append(path)
        return sorted(found)

    # ------------------------------------------------------------------
    # Python analysis
    # ------------------------------------------------------------------

    def _analyze_python(self, files: List[Path], profile: PatternProfile) -> None:
        import_counter: Counter = Counter()
        func_names: List[str] = []
        has_classes = False
        has_fixtures = False

        for path in files:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            # Imports
            for m in re.finditer(
                r"^(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))",
                text,
                re.MULTILINE,
            ):
                module = (m.group(1) or m.group(2) or "").split()[0].rstrip(",")
                if module:
                    import_counter[module] += 1

            # Test function names
            for m in re.finditer(r"^\s*def\s+(test_\w+)", text, re.MULTILINE):
                func_names.append(m.group(1))

            # Class-based tests
            if re.search(r"^\s*class\s+Test\w+", text, re.MULTILINE):
                has_classes = True

            # Fixtures
            if re.search(r"@pytest\.fixture|conftest", text):
                has_fixtures = True

        profile.uses_classes = has_classes
        profile.uses_fixtures = has_fixtures
        profile.common_imports = [m for m, _ in import_counter.most_common(8)]
        profile.sample_names = func_names[:5]
        profile.naming_style = self._python_naming_style(func_names, has_classes)
        profile.assertion_style = "unittest self.assert* methods" if has_classes else "pytest assert statements"

    def _python_naming_style(self, names: List[str], uses_classes: bool) -> str:
        if not names:
            style = "class-based" if uses_classes else "function-based"
            return f"{style} pytest tests"

        # Detect common prefixes after test_
        bodies = [n[len("test_"):] for n in names if n.startswith("test_")]
        should_count = sum(1 for b in bodies if b.startswith("should_"))
        when_count = sum(1 for b in bodies if b.startswith("when_"))
        raises_count = sum(1 for b in bodies if "raises" in b or "error" in b)

        if should_count > len(bodies) // 2:
            pattern = "test_should_* convention"
        elif when_count > len(bodies) // 2:
            pattern = "test_when_* convention"
        elif raises_count > len(bodies) // 3:
            pattern = "test_<action>_raises_* convention"
        else:
            pattern = "test_<action>_<result> convention"

        struct = "class-based" if uses_classes else "function-based"
        return f"{struct} pytest, {pattern}"

    # ------------------------------------------------------------------
    # JavaScript / TypeScript analysis
    # ------------------------------------------------------------------

    def _analyze_js(self, files: List[Path], profile: PatternProfile) -> None:
        import_counter: Counter = Counter()
        test_names: List[str] = []
        has_describe = False

        for path in files:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            # ES module imports
            for m in re.finditer(
                r"""^import\s+.*?\s+from\s+['"]([^'"]+)['"]""",
                text,
                re.MULTILINE,
            ):
                import_counter[m.group(1)] += 1

            # CommonJS require
            for m in re.finditer(r"""require\(['"]([^'"]+)['"]\)""", text):
                import_counter[m.group(1)] += 1

            # describe / it / test names
            if re.search(r"\bdescribe\s*\(", text):
                has_describe = True
            for m in re.finditer(
                r"""\b(?:it|test)\s*\(\s*['"]([^'"]{3,60})['"]""", text
            ):
                test_names.append(m.group(1))

        profile.uses_describe = has_describe
        profile.common_imports = [m for m, _ in import_counter.most_common(8)]
        profile.sample_names = test_names[:5]
        profile.naming_style = self._js_naming_style(test_names, has_describe)
        profile.assertion_style = self._js_assertion_style(
            [p for p in import_counter if "expect" in p or "chai" in p or "assert" in p]
        )

    def _js_naming_style(self, names: List[str], uses_describe: bool) -> str:
        structure = "describe/it blocks" if uses_describe else "top-level test() calls"
        if not names:
            return structure

        # Detect sentence-style vs should-style
        should_count = sum(1 for n in names if n.lower().startswith("should"))
        sentence = sum(1 for n in names if n[0].isupper())

        if should_count > len(names) // 2:
            style = "should-style names"
        elif sentence > len(names) // 2:
            style = "sentence-style names"
        else:
            style = "imperative names"

        return f"{structure}, {style}"

    def _js_assertion_style(self, assertion_imports: List[str]) -> str:
        if any("chai" in i for i in assertion_imports):
            return "chai expect assertions"
        if any("assert" in i for i in assertion_imports):
            return "assert-style assertions"
        return "expect().toBe() / toEqual() assertions"
