# agent/core/fixture_scanner.py

"""Project test-fixture / helper symbol scanner.

Scans the user's test fixture and helper modules (e.g. tests/fixtures/,
test-utils/, helpers/) and extracts the named exports from each file.
This list is injected into the generation prompt as a "Project Symbols"
section so the LLM imports real identifiers from the project instead of
inventing plausible-sounding ones (#62).

Lightweight by design: regex-based, no external parser dependency. The
goal is to ground the LLM, not to produce a perfect AST.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


# Where projects typically keep test helpers and fixtures. Order matters
# only insofar as we deduplicate by resolved path.
_FIXTURE_DIRS = (
    "tests/fixtures",
    "tests/test-utils",
    "tests/helpers",
    "tests/support",
    "test/fixtures",
    "test/test-utils",
    "test/helpers",
    "e2e/fixtures",
    "e2e/helpers",
    "__tests__/fixtures",
    "__tests__/helpers",
    "fixtures",
    "test-utils",
)

_IGNORED_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "coverage",
}

_MAX_FILES = 20
_MAX_FILE_BYTES = 32_768
_MAX_SYMBOLS_PER_FILE = 12

# TS/JS: `export const FOO`, `export function bar`, `export class Baz`,
# `export let x`, `export async function y`, `export default function z`.
_TS_DECL_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?"
    r"(?:async\s+)?"
    r"(?:const|let|var|function|class|interface|type|enum)\s+"
    r"([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)

# TS/JS: `export { foo, bar as baz }`.
_TS_NAMED_RE = re.compile(r"^\s*export\s*\{([^}]+)\}", re.MULTILINE)

# Python: top-level `def foo` / `class Bar` (skip dunder/private).
_PY_DECL_RE = re.compile(
    r"^(?:def|class)\s+([A-Za-z][\w]*)",
    re.MULTILINE,
)


@dataclass
class FixtureSymbols:
    """Map of import-style path -> ordered list of exported symbols."""

    # Relative path (POSIX, project-rooted) -> list of exported names.
    by_module: Dict[str, List[str]] = field(default_factory=dict)
    files_scanned: int = 0

    @property
    def is_empty(self) -> bool:
        return not self.by_module


class FixtureScanner:
    """Extracts exported symbols from project test-fixture/helper modules."""

    def scan(self, project_root: str = ".") -> FixtureSymbols:
        root = Path(project_root).resolve()
        result = FixtureSymbols()
        if not root.exists():
            return result

        candidates: List[Path] = []
        seen: set = set()
        for rel in _FIXTURE_DIRS:
            d = root / rel
            if not d.is_dir():
                continue
            if d in seen:
                continue
            seen.add(d)
            for path in sorted(d.rglob("*")):
                if not path.is_file():
                    continue
                if any(part in _IGNORED_DIRS for part in path.parts):
                    continue
                if path.suffix not in (".ts", ".tsx", ".js", ".jsx", ".py"):
                    continue
                candidates.append(path)
                if len(candidates) >= _MAX_FILES:
                    break
            if len(candidates) >= _MAX_FILES:
                break

        for path in candidates:
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if len(text) > _MAX_FILE_BYTES:
                text = text[:_MAX_FILE_BYTES]

            symbols = (
                _extract_python(text) if path.suffix == ".py"
                else _extract_ts(text)
            )
            if not symbols:
                continue

            rel_path = path.relative_to(root).as_posix()
            result.by_module[rel_path] = symbols[:_MAX_SYMBOLS_PER_FILE]
            result.files_scanned += 1

        return result


def _extract_ts(text: str) -> List[str]:
    """Return ordered list of exported names from TS/JS source text."""
    seen: List[str] = []
    seen_set: set = set()

    def add(name: str) -> None:
        name = name.strip()
        if not name or name in seen_set:
            return
        seen_set.add(name)
        seen.append(name)

    for m in _TS_DECL_RE.finditer(text):
        add(m.group(1))

    for m in _TS_NAMED_RE.finditer(text):
        # "foo, bar as baz, qux" -> ["bar" (the rebound name wins via `as`)]
        for piece in m.group(1).split(","):
            piece = piece.strip()
            if not piece:
                continue
            if " as " in piece:
                _, _, alias = piece.partition(" as ")
                add(alias)
            else:
                add(piece)

    return seen


def _extract_python(text: str) -> List[str]:
    """Return ordered list of top-level public names from Python source."""
    seen: List[str] = []
    seen_set: set = set()
    for m in _PY_DECL_RE.finditer(text):
        name = m.group(1)
        if name.startswith("_"):
            continue
        if name in seen_set:
            continue
        seen_set.add(name)
        seen.append(name)
    return seen
