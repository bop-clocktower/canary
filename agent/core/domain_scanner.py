# agent/core/domain_scanner.py

"""Domain knowledge scanner for Canary.

Scans the user's project source files (not test files) to extract
components, public functions, and API routes. This domain context is
injected into the generation prompt so the LLM can reference real
symbols and endpoints rather than inventing them.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List


_IGNORED_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", ".harness",
    "tests", "test", "__tests__", "spec", "coverage",
}

_TEST_FILE_RE = re.compile(
    r"(^test_|_test\.py$|\.spec\.|\.test\.)",
    re.IGNORECASE,
)

_MAX_SOURCE_FILES = 20
_MAX_FILE_BYTES = 32_768
_MAX_ITEMS = 15   # cap per category to keep prompt concise


@dataclass
class DomainContext:
    """Domain knowledge extracted from a project's source files."""

    source_files: int = 0
    modules: List[str] = field(default_factory=list)     # importable module paths
    components: List[str] = field(default_factory=list)  # classes / React components
    functions: List[str] = field(default_factory=list)   # public functions
    api_routes: List[str] = field(default_factory=list)  # HTTP route patterns

    @property
    def is_empty(self) -> bool:
        return self.source_files == 0


class DomainScanner:
    """Scans project source files and returns a DomainContext."""

    def scan(self, project_root: str = ".") -> DomainContext:
        """
        Scan project_root for source files and extract domain symbols.

        Skips test files, ignored directories, and files exceeding the
        size limit. Language is inferred from file extension.

        Args:
            project_root: Directory to scan. Defaults to cwd.

        Returns:
            DomainContext populated from discovered source files.
            Returns an empty context if no source files are found.
        """
        root = Path(project_root).resolve()
        py_files = self._find_source_files(root, ["**/*.py"])
        js_files = self._find_source_files(
            root, ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
        )
        all_files = (py_files + js_files)[:_MAX_SOURCE_FILES]

        if not all_files:
            return DomainContext()

        ctx = DomainContext(source_files=len(all_files))
        ctx.modules = self._derive_modules(root, all_files)

        for path in all_files:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if path.suffix == ".py":
                self._extract_python(text, ctx)
            else:
                self._extract_js(text, ctx)

        ctx.components = _dedup_cap(ctx.components)
        ctx.functions = _dedup_cap(ctx.functions)
        ctx.api_routes = _dedup_cap(ctx.api_routes)
        return ctx

    # ------------------------------------------------------------------
    # File discovery
    # ------------------------------------------------------------------

    def _find_source_files(self, root: Path, patterns: List[str]) -> List[Path]:
        found: List[Path] = []
        seen: set = set()
        for pattern in patterns:
            for path in root.glob(pattern):
                if path in seen:
                    continue
                if any(part in _IGNORED_DIRS for part in path.parts):
                    continue
                if _TEST_FILE_RE.search(path.name):
                    continue
                try:
                    if path.stat().st_size > _MAX_FILE_BYTES:
                        continue
                except OSError:
                    continue
                seen.add(path)
                found.append(path)
        return sorted(found)

    def _derive_modules(self, root: Path, files: List[Path]) -> List[str]:
        modules: List[str] = []
        for path in files:
            try:
                rel = path.relative_to(root)
            except ValueError:
                continue
            parts = list(rel.parts)
            # strip extension
            parts[-1] = re.sub(r"\.(py|tsx?|jsx?)$", "", parts[-1])
            # skip __init__
            if parts[-1] == "__init__":
                parts = parts[:-1]
            if parts:
                modules.append("/".join(parts))
        return modules[:_MAX_ITEMS]

    # ------------------------------------------------------------------
    # Python extraction
    # ------------------------------------------------------------------

    def _extract_python(self, text: str, ctx: DomainContext) -> None:
        for m in re.finditer(r"^class\s+([A-Za-z]\w*)", text, re.MULTILINE):
            ctx.components.append(m.group(1))

        for m in re.finditer(r"^def\s+([a-z]\w*)\s*\(", text, re.MULTILINE):
            name = m.group(1)
            if not name.startswith("_"):
                ctx.functions.append(name)

        # Flask / FastAPI / Starlette route decorators
        for m in re.finditer(
            r"@(?:app|router|bp)\.(get|post|put|patch|delete|route)\s*\(\s*['\"]([^'\"]+)['\"]",
            text,
            re.IGNORECASE,
        ):
            method = m.group(1).upper()
            path_val = m.group(2)
            if method == "ROUTE":
                ctx.api_routes.append(path_val)
            else:
                ctx.api_routes.append(f"{method} {path_val}")

    # ------------------------------------------------------------------
    # JavaScript / TypeScript extraction
    # ------------------------------------------------------------------

    def _extract_js(self, text: str, ctx: DomainContext) -> None:
        # export class Foo / export default class Foo
        for m in re.finditer(
            r"\bexport\s+(?:default\s+)?class\s+([A-Za-z]\w*)", text
        ):
            ctx.components.append(m.group(1))

        # export function foo / export default function Foo
        for m in re.finditer(
            r"\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z]\w*)", text
        ):
            name = m.group(1)
            # PascalCase with JSX suffix → treat as component
            if name[0].isupper():
                ctx.components.append(name)
            else:
                ctx.functions.append(name)

        # export const foo = / export const Foo =
        for m in re.finditer(
            r"\bexport\s+const\s+([A-Za-z]\w*)\s*(?::[^=]+)?\s*=", text
        ):
            name = m.group(1)
            if name[0].isupper():
                ctx.components.append(name)
            else:
                ctx.functions.append(name)

        # Express-style routes: router.get('/...') / app.post('/...')
        for m in re.finditer(
            r"\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['\"]([^'\"]+)['\"]",
            text,
            re.IGNORECASE,
        ):
            ctx.api_routes.append(f"{m.group(1).upper()} {m.group(2)}")


def _dedup_cap(items: List[str]) -> List[str]:
    seen: set = set()
    result: List[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
        if len(result) >= _MAX_ITEMS:
            break
    return result
