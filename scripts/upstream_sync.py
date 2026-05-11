#!/usr/bin/env python3
"""Sanitize the fork's tree for upstreaming to oracle-test-ai-agent.

Two ways content stays out of upstream:

1. Whole paths listed in FORK_ONLY_PATHS are skipped entirely.
2. Inline blocks in markdown files wrapped with
       <!-- fork-only:capillary -->
       ...content...
       <!-- /fork-only -->
   are stripped (along with the markers themselves).

Modes:

- `--check` (default): scan every markdown file in the repo, validate
  that fork-only markers are balanced (every opener has a closer, no
  nesting, recognised tag). Exit non-zero on any imbalance. Used by CI.

- `--build [target-dir]`: produce a sanitized copy of the working tree
  at `target-dir` (default `.upstream-sync/`). Skips FORK_ONLY_PATHS,
  strips marker blocks, removes resulting blank-line runs. The
  target-dir is gitignored locally; commit its contents to a separate
  branch for the upstream PR.

The set of marker keys (e.g. `capillary`) is open-ended — any value is
accepted in the marker syntax. CI checks structure, not which keys are
used, so it stays useful if other fork variants are added later.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]

# Paths excluded from the upstream tree wholesale (relative to repo root).
# Reserved directory roots and individual files that are fork-only.
FORK_ONLY_PATHS: tuple[str, ...] = (
    "capillary",
    "docs/capillary",
    ".harness/capillary",
    # Fork-management tooling — meaningful only in this fork.
    "docs/FORK_POLICY.md",
    "scripts/upstream_sync.py",
    ".github/workflows/fork-policy.yml",
)

# Paths the script does not touch even in --build (sync artifacts,
# build outputs, VCS internals).
NEVER_COPY: tuple[str, ...] = (
    ".git",
    ".upstream-sync",
    "node_modules",
    "__pycache__",
)

OPEN_RE = re.compile(r"<!--\s*fork-only:([A-Za-z0-9_-]+)\s*-->")
CLOSE_RE = re.compile(r"<!--\s*/fork-only\s*-->")
BLOCK_RE = re.compile(
    r"<!--\s*fork-only:[A-Za-z0-9_-]+\s*-->.*?<!--\s*/fork-only\s*-->\n?",
    re.DOTALL,
)
MULTI_BLANK_RE = re.compile(r"\n{3,}")


def strip_fenced_blocks(text: str) -> str:
    """Return `text` with fenced code blocks blanked out (length-preserved
    so regex offsets in the original could still be mapped, but we only
    use this for marker scanning, not stripping)."""
    out = []
    in_fence = False
    for line in text.splitlines(keepends=True):
        if line.startswith("```"):
            in_fence = not in_fence
            out.append("\n")
            continue
        out.append("\n" if in_fence else line)
    return "".join(out)


class MarkerError(Exception):
    """Raised when fork-only markers are malformed."""


def iter_markdown_files() -> Iterable[Path]:
    for path in REPO_ROOT.rglob("*.md"):
        rel = path.relative_to(REPO_ROOT)
        if any(part in NEVER_COPY for part in rel.parts):
            continue
        yield path


def check_markers(path: Path) -> list[str]:
    """Return a list of human-readable problems for a single file."""
    raw = path.read_text()
    text = strip_fenced_blocks(raw)
    problems: list[str] = []
    opens = list(OPEN_RE.finditer(text))
    closes = list(CLOSE_RE.finditer(text))
    if len(opens) != len(closes):
        problems.append(
            f"{path.relative_to(REPO_ROOT)}: "
            f"{len(opens)} opener(s) vs {len(closes)} closer(s)"
        )
    # Reject nesting: every opener must have its matching closer before
    # the next opener.
    cursor = 0
    for opener in opens:
        next_close = CLOSE_RE.search(text, opener.end())
        next_open = OPEN_RE.search(text, opener.end())
        if next_close is None:
            problems.append(
                f"{path.relative_to(REPO_ROOT)}: "
                f"unterminated marker at offset {opener.start()}"
            )
            break
        if next_open and next_open.start() < next_close.start():
            problems.append(
                f"{path.relative_to(REPO_ROOT)}: "
                "nested fork-only markers are not allowed"
            )
            break
        cursor = next_close.end()
    _ = cursor
    return problems


def strip_markers(text: str) -> str:
    """Remove fork-only blocks, ignoring markers inside fenced code."""
    out: list[str] = []
    in_fence = False
    skip = False
    for line in text.splitlines(keepends=True):
        if line.startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        if not in_fence:
            if OPEN_RE.match(line.strip()):
                skip = True
                continue
            if skip and CLOSE_RE.match(line.strip()):
                skip = False
                continue
        if not skip:
            out.append(line)
    cleaned = "".join(out)
    cleaned = MULTI_BLANK_RE.sub("\n\n", cleaned)
    return cleaned


def cmd_check() -> int:
    all_problems: list[str] = []
    for md in iter_markdown_files():
        all_problems.extend(check_markers(md))
    if all_problems:
        print("Fork-only marker check failed:", file=sys.stderr)
        for line in all_problems:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("Fork-only marker check passed.")
    return 0


def is_excluded_path(rel: Path) -> bool:
    rel_str = str(rel).replace("\\", "/")
    for prefix in FORK_ONLY_PATHS:
        if rel_str == prefix or rel_str.startswith(prefix + "/"):
            return True
    return False


def cmd_build(target: Path) -> int:
    if check_markers_for_build() != 0:
        return 2
    target = target.resolve()
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    for src in REPO_ROOT.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(REPO_ROOT)
        if any(part in NEVER_COPY for part in rel.parts):
            continue
        if is_excluded_path(rel):
            continue
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix == ".md":
            dst.write_text(strip_markers(src.read_text()))
        else:
            shutil.copy2(src, dst)

    print(f"Sanitized tree written to {target}")
    print("Next: copy contents to a fresh branch off upstream/main,")
    print("commit, and open the upstream PR.")
    return 0


def check_markers_for_build() -> int:
    problems: list[str] = []
    for md in iter_markdown_files():
        problems.extend(check_markers(md))
    if problems:
        print("Refusing to build: marker errors detected.", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("check", help="Validate fork-only markers (default).")

    build = sub.add_parser("build", help="Write a sanitized tree.")
    build.add_argument(
        "target",
        nargs="?",
        default=str(REPO_ROOT / ".upstream-sync"),
        help="Target directory (default: .upstream-sync/)",
    )

    args = parser.parse_args(argv)
    if args.cmd is None or args.cmd == "check":
        return cmd_check()
    if args.cmd == "build":
        return cmd_build(Path(args.target))
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
