#!/usr/bin/env python3
"""diffscan -- find deleted and newly-skipped tests in a unified diff.

The scanner is line-oriented and parser-free so it ships anywhere python3 does.
It classifies each event as a REMOVED test (a test declaration that left on a
`-` line) or a SKIPPED test (a skip/xfail/only marker that arrived on a `+`
line), and -- when pointed at a git repo -- attaches the provenance of the
commit that made the change.

A test flipped in place from `it('x')` to `it.skip('x')` is one event, not two:
the skip supersedes the removal so the ledger never double-counts it.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional


class Kind(Enum):
    REMOVED = "removed"
    SKIPPED = "skipped"


@dataclass
class Deletion:
    name: str
    file: str
    kind: Kind
    line: int = 0
    marker: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "file": self.file,
            "kind": self.kind.value,
            "line": self.line,
            "marker": self.marker,
        }


# --------------------------------------------------------------------------
# test-file classification
# --------------------------------------------------------------------------

_TEST_DIR_SEGMENTS = {"tests", "test", "__tests__", "e2e", "spec"}
_TEST_BASENAME_RE = re.compile(
    r"(^test_.*\.py$)|(.*_test\.py$)|(.*\.spec\..+$)|(.*\.test\..+$)"
)


def is_test_file(path: str) -> bool:
    """Does ``path`` look like a test file?

    Matches on path *segments* (not substrings) so ``src/latest/api.py`` -- which
    merely contains "test" inside "latest" -- is correctly rejected, while
    ``test/legacy/thing.js`` is accepted for its ``test`` directory.
    """
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if not parts:
        return False
    if any(seg in _TEST_DIR_SEGMENTS for seg in parts[:-1]):
        return True
    return bool(_TEST_BASENAME_RE.match(parts[-1]))


# --------------------------------------------------------------------------
# diff parsing
# --------------------------------------------------------------------------

_PY_DEF_TEST = re.compile(r"^(?:async\s+)?def\s+(test\w*)\s*\(")
_PY_DEF_ANY = re.compile(r"^(?:async\s+)?def\s+(\w+)\s*\(")
_PY_SKIP_DEC = re.compile(r"^@(pytest\.mark\.(?:skip|skipif|xfail)\b.*)$")
_JS_DECL = re.compile(
    r"\b(?:describe|context|it|test)(?:\.\w+)?\s*\(\s*(['\"`])(.*?)\1"
)
_JS_SKIP = re.compile(
    r"\b(xit|xdescribe|fit|fdescribe|(?:it|test|describe|context)\.(?:skip|only))"
    r"\s*\(\s*(['\"`])(.*?)\2"
)
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def _strip_ab(path: str) -> str:
    if path.startswith(("a/", "b/")):
        return path[2:]
    return path


def find_deletions(diff: str) -> list[Deletion]:
    """Parse a unified diff and return the deletions/skips it introduces."""
    removed: dict[tuple[str, str], Deletion] = {}
    skipped: dict[tuple[str, str], Deletion] = {}

    current_file: Optional[str] = None
    in_test_file = False
    in_hunk = False
    old_ln = new_ln = 0
    pending_py_marker: Optional[str] = None

    def note_py_def(content: str, file: str) -> None:
        nonlocal pending_py_marker
        if pending_py_marker is None:
            return
        m = _PY_DEF_ANY.match(content)
        if m:
            name = m.group(1)
            skipped[(file, name)] = Deletion(
                name=name, file=file, kind=Kind.SKIPPED, marker=pending_py_marker
            )
            pending_py_marker = None

    for raw in diff.split("\n"):
        if raw.startswith("diff --git"):
            in_hunk = False
            current_file = None
            in_test_file = False
            pending_py_marker = None
            continue
        if raw.startswith("--- "):
            continue
        if raw.startswith("+++ "):
            target = _strip_ab(raw[4:].strip())
            if target == "/dev/null":
                current_file = None
                in_test_file = False
            else:
                current_file = target
                in_test_file = is_test_file(target)
            in_hunk = False
            pending_py_marker = None
            continue
        m = _HUNK_RE.match(raw)
        if m:
            old_ln = int(m.group(1))
            new_ln = int(m.group(2))
            in_hunk = True
            pending_py_marker = None
            continue
        if not in_hunk or current_file is None:
            continue

        if raw.startswith("\\"):  # "\ No newline at end of file"
            continue

        if raw.startswith("+"):
            content = raw[1:].lstrip()
            if in_test_file:
                dec = _PY_SKIP_DEC.match(content)
                if dec:
                    pending_py_marker = dec.group(1)
                else:
                    note_py_def(content, current_file)
                    for mm in _JS_SKIP.finditer(content):
                        marker, _q, title = mm.group(1), mm.group(2), mm.group(3)
                        skipped[(current_file, title)] = Deletion(
                            name=title,
                            file=current_file,
                            kind=Kind.SKIPPED,
                            line=new_ln,
                            marker=marker,
                        )
            new_ln += 1
        elif raw.startswith("-"):
            content = raw[1:].lstrip()
            if in_test_file:
                py = _PY_DEF_TEST.match(content)
                if py:
                    name = py.group(1)
                    removed[(current_file, name)] = Deletion(
                        name=name, file=current_file, kind=Kind.REMOVED, line=old_ln
                    )
                else:
                    jm = _JS_DECL.search(content)
                    if jm:
                        title = jm.group(2)
                        removed[(current_file, title)] = Deletion(
                            name=title,
                            file=current_file,
                            kind=Kind.REMOVED,
                            line=old_ln,
                        )
            old_ln += 1
        else:  # context line (leading space, or a bare blank line)
            content = raw[1:] if raw.startswith(" ") else raw
            if in_test_file:
                note_py_def(content.lstrip(), current_file)
            old_ln += 1
            new_ln += 1

    # A skip supersedes a removal of the same test: report it once, as a skip.
    result: dict[tuple[str, str], Deletion] = {}
    for key, deletion in removed.items():
        result[key] = deletion
    for key, deletion in skipped.items():
        result[key] = deletion

    return sorted(result.values(), key=lambda d: (d.file, d.name))


# --------------------------------------------------------------------------
# git plumbing (only ever run against the caller's repo path)
# --------------------------------------------------------------------------


@dataclass
class Commit:
    sha: str
    author: str
    date: str
    subject: str


def run_git(repo: Path, *args: str) -> str:
    """Run git in ``repo`` and return stdout. Raises on non-zero exit."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc.stdout


_BASE_CANDIDATES = ("origin/main", "origin/master", "main", "master", "develop")


def resolve_base(repo: Path, ref: Optional[str]) -> str:
    """Resolve the comparison base.

    An explicit ``ref`` is returned verbatim. Otherwise the merge-base of HEAD
    with the first available mainline branch is used, falling back to HEAD's
    parent when no mainline branch exists.
    """
    if ref:
        return ref
    for candidate in _BASE_CANDIDATES:
        try:
            run_git(repo, "rev-parse", "--verify", "--quiet", candidate)
        except subprocess.CalledProcessError:
            continue
        return run_git(repo, "merge-base", "HEAD", candidate).strip()
    return run_git(repo, "rev-parse", "HEAD~1").strip()


def diff_text(repo: Path, base: str) -> str:
    """Unified diff from ``base`` to HEAD."""
    return run_git(repo, "diff", base, "HEAD")


def commit_for_file(repo: Path, base: str, path: str) -> Optional[Commit]:
    """Provenance of the most recent commit in ``base``..HEAD touching ``path``.

    Returns None when no commit in the range changed the path.
    """
    fmt = "%H%n%an%n%aI%n%s"
    out = run_git(
        repo,
        "log",
        "-1",
        f"--format={fmt}",
        f"{base}..HEAD",
        "--",
        path,
    )
    lines = out.splitlines()
    if len(lines) < 4:
        return None
    return Commit(sha=lines[0], author=lines[1], date=lines[2], subject=lines[3])
