#!/usr/bin/env python3
"""Materialize Python module docstrings into ``docs/knowledge/<domain>/<module>.md``.

Local stand-in until the upstream harness graph package ships native Python
support.

The harness ``KnowledgeIngestor`` reads markdown files with YAML frontmatter
from ``docs/knowledge/`` and materializes them as ``business_rule`` /
``business_concept`` nodes in the graph. This script AST-walks Python files
under the configured roots, picks up every module/class/function with a
docstring, and writes one markdown page per module under
``docs/knowledge/<domain>/<module>.md``.

Default roots include ``tests`` so test-function docstrings — the
intended human-readable "rule" wording for each behavior under test —
are materialized at confidence ≥0.6 rather than left as name-only 0.5
stubs from the upstream ``test-descriptions`` extractor.

Re-running the script is idempotent — pages are overwritten with the latest
docstrings. Delete the directory and re-run for a clean rebuild.

Usage:

    python3 scripts/extract_python_docstrings.py
    npx -p canary-test-cli harness ingest --source knowledge --full
    npx -p canary-test-cli harness knowledge-pipeline

Coverage rises in the domain matching the module's root directory.
"""

from __future__ import annotations

import argparse
import ast
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

_REPO_ROOT = Path(__file__).resolve().parents[1]
# Include `tests` so test function docstrings become high-confidence
# knowledge nodes alongside the upstream `test-descriptions` extractor's
# name-only 0.5-confidence stubs (#21).
_DEFAULT_ROOTS = ("agent", "scripts", "tests")
_OUT_DIR = _REPO_ROOT / "docs" / "knowledge"
_SKIP_DIRS = {
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".pytest_cache",
    ".mypy_cache",
    "build",
    "dist",
    "node_modules",
    ".git",
    ".harness",
}


@dataclass(frozen=True)
class Symbol:
    """One documentable thing extracted from a Python source file.

    ``kind`` is one of ``module`` / ``class`` / ``function`` / ``method`` and
    drives how the symbol is rendered in the output markdown.
    """

    qualname: str
    name: str
    kind: str
    line: int
    docstring: str


def _confidence(docstring: str) -> float:
    """Score docstring narrative quality. Multi-line, >80 chars → 0.9; one-liner → 0.6."""
    stripped = docstring.strip()
    if not stripped:
        return 0.0
    lines = [line for line in stripped.splitlines() if line.strip()]
    if len(lines) >= 3 and len(stripped) >= 80:
        return 0.9
    if len(lines) >= 2 or len(stripped) >= 60:
        return 0.8
    return 0.6


def _module_path(file_path: Path) -> str:
    """Convert a repo-relative ``.py`` path to its dotted module name."""
    rel = file_path.relative_to(_REPO_ROOT).with_suffix("")
    return ".".join(rel.parts)


def _domain_of(file_path: Path) -> str:
    """Bucket a file into a top-level domain (``agent`` / ``scripts`` / ...)."""
    return file_path.relative_to(_REPO_ROOT).parts[0]


def _iter_py_files(roots: Iterable[Path]) -> Iterator[Path]:
    """Yield every ``.py`` file under ``roots`` that isn't in ``_SKIP_DIRS``."""
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*.py"):
            if any(part in _SKIP_DIRS for part in path.parts):
                continue
            yield path


def _walk_symbols(tree: ast.Module, file_path: Path) -> list[Symbol]:
    """Return every documented symbol in a parsed module.

    Walks the AST in source order and emits a ``Symbol`` for the module
    itself (if it has a docstring) plus every nested class / function /
    method whose ``ast.get_docstring`` returns a non-empty value. Symbols
    without docstrings are skipped — there's nothing to render for them.
    """
    module = _module_path(file_path)
    symbols: list[Symbol] = []

    module_doc = ast.get_docstring(tree)
    if module_doc:
        symbols.append(
            Symbol(qualname=module, name=module, kind="module", line=1, docstring=module_doc.strip())
        )

    class _Visitor(ast.NodeVisitor):
        """AST visitor that flattens nested classes/functions into ``symbols``.

        Tracks an enclosing-name ``stack`` so qualnames render correctly for
        methods (``module.Cls.method``) and nested functions
        (``module.outer.inner``).
        """

        def __init__(self) -> None:
            """Start with an empty enclosing-name stack."""
            self.stack: list[str] = []

        def _emit(self, node: ast.AST, kind: str) -> None:
            """Append one ``Symbol`` if the node has a docstring."""
            doc = ast.get_docstring(node)
            if not doc:
                return
            name = getattr(node, "name", "<anon>")
            qualname = ".".join([module, *self.stack, name])
            symbols.append(
                Symbol(
                    qualname=qualname,
                    name=name,
                    kind=kind,
                    line=getattr(node, "lineno", 0),
                    docstring=doc.strip(),
                )
            )

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            """Emit the class symbol, then recurse with the class name pushed."""
            self._emit(node, "class")
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            """Emit the function/method symbol, then recurse with its name pushed.

            ``kind`` flips to ``method`` whenever the enclosing-name stack is
            non-empty (i.e. we're inside a class body).
            """
            kind = "method" if self.stack else "function"
            self._emit(node, kind)
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

    _Visitor().visit(tree)
    return symbols


def _render_module(module: str, domain: str, source_rel: Path, symbols: list[Symbol]) -> str:
    """Render one markdown page documenting a Python module's symbols.

    The harness frontmatter schema (see KnowledgeIngestor) reads:
      - ``id``: stable identifier
      - ``domain``: top-level bucket (agent / scripts / tests)
      - ``type``: ``business_rule`` or ``business_concept``
      - ``confidence``: float 0-1
    """
    module_symbol = next((s for s in symbols if s.kind == "module"), None)
    confidence = _confidence(module_symbol.docstring) if module_symbol else 0.7
    lines: list[str] = []
    lines.append("---")
    lines.append(f"id: oracle-py.{module}")
    lines.append(f"domain: {domain}")
    lines.append("type: business_concept")
    lines.append(f"confidence: {confidence}")
    lines.append(f"source: {source_rel.as_posix()}")
    lines.append("auto_generated: true")
    lines.append("generator: scripts/extract_python_docstrings.py")
    lines.append("---")
    lines.append("")
    # H1 uses the full dotted module path. The harness linker matches H1 text
    # against code symbols and emits spurious `definition_conflict` warnings
    # for any name that appears in multiple files of the same package — the
    # full path produces the fewest false positives (a leaf-only heading
    # collides with every sibling module).
    lines.append(f"# `{module}`")
    lines.append("")
    lines.append(f"_Auto-generated from [`{source_rel.as_posix()}`]({_REPO_RELATIVE_LINK})._")
    lines.append("")
    if module_symbol:
        lines.append("## Module")
        lines.append("")
        lines.append(module_symbol.docstring)
        lines.append("")
    others = [s for s in symbols if s.kind != "module"]
    if others:
        lines.append("## Symbols")
        lines.append("")
        for sym in others:
            tag = f"`{sym.kind}` &nbsp;·&nbsp; `{sym.qualname.split('.')[-1]}` &nbsp;·&nbsp; line {sym.line}"
            lines.append(f"### {sym.name}")
            lines.append("")
            lines.append(tag)
            lines.append("")
            lines.append(sym.docstring)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# A placeholder we substitute per-file at render time; the link target needs
# to point back to the source from the docs/knowledge/<domain>/ location.
_REPO_RELATIVE_LINK = "../../../{src}"


def extract_and_write(roots: list[Path], out_dir: Path, *, clean: bool) -> int:
    """Scan ``roots`` and write one markdown page per documented module.

    With ``clean=True`` the per-domain subdirectories of ``out_dir`` are
    wiped before writing, guaranteeing the output reflects the current
    source tree (deleted modules don't linger as ghost pages). Returns
    the number of pages written.
    """
    if clean and out_dir.exists():
        for sub in out_dir.iterdir():
            if sub.is_dir():
                shutil.rmtree(sub)

    written = 0
    for py_file in _iter_py_files(roots):
        try:
            tree = ast.parse(py_file.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError) as exc:
            print(f"::warning::skipped {py_file}: {exc}", file=sys.stderr)
            continue
        symbols = _walk_symbols(tree, py_file)
        if not symbols:
            continue

        module = _module_path(py_file)
        domain = _domain_of(py_file)
        rel_source = py_file.relative_to(_REPO_ROOT)
        page = _render_module(
            module=module,
            domain=domain,
            source_rel=rel_source,
            symbols=symbols,
        ).replace("{src}", rel_source.as_posix())

        page_path = out_dir / domain / f"{module.replace('.', '__')}.md"
        page_path.parent.mkdir(parents=True, exist_ok=True)
        page_path.write_text(page, encoding="utf-8")
        written += 1
    return written


def main() -> int:
    """CLI entry point — parse flags and invoke ``extract_and_write``.

    Exit code 0 on success. Doesn't error on empty input (an empty result
    is informational — printed to stdout). Skipped files (unparseable
    Python, bad encoding) emit ``::warning::`` lines on stderr without
    failing the run.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        action="append",
        default=None,
        help="Path(s) to scan, relative to repo root. Defaults to agent + scripts + tests.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=_OUT_DIR,
        help=f"Output directory (default: {_OUT_DIR.relative_to(_REPO_ROOT)})",
    )
    parser.add_argument(
        "--no-clean",
        action="store_true",
        help="Don't wipe existing per-domain subdirs before writing.",
    )
    args = parser.parse_args()

    roots = [_REPO_ROOT / r for r in (args.root if args.root else _DEFAULT_ROOTS)]
    count = extract_and_write(roots, args.out, clean=not args.no_clean)
    print(f"wrote {count} module pages to {args.out.relative_to(_REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
