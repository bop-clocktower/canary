"""Tier 0 deterministic PR guardian engine.

Scopes a git diff into changed units, resolves diff-coverage at the highest
available fidelity (see :mod:`agent.guardian.coverage`), builds fidelity-labeled
findings, honors ``canary:allow-untested`` suppressions, renders output, and
computes a soft/hard gate exit code.

SC-11 boundary: imports **no** ``AgentTier``/LLM/agent module and never
references the ``analyze_diff``/``get_impact`` MCP tools.
"""

from __future__ import annotations

import re
import subprocess
import sys

from agent.guardian.coverage import ChangedUnit

_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _merge_lines(lines: list[int]) -> list[tuple[int, int]]:
    """Collapse a sorted list of line numbers into inclusive ``(start, end)`` ranges."""
    ranges: list[tuple[int, int]] = []
    for line in sorted(lines):
        if ranges and line == ranges[-1][1] + 1:
            start, _ = ranges[-1]
            ranges[-1] = (start, line)
        else:
            ranges.append((line, line))
    return ranges


def scope_diff(diff_text: str) -> list[ChangedUnit]:
    """Parse a unified diff into one :class:`ChangedUnit` per file with added lines.

    Collects ADDED line numbers (from ``@@`` headers + ``+`` body lines) on the
    new-file (``b/``) side. Deletions and context lines are ignored for range
    purposes. Deleted files (``+++ /dev/null``) and files with no additions are
    excluded from the result.
    """
    added_by_path: dict[str, list[int]] = {}
    current_path: str | None = None
    new_lineno = 0
    skip_current = False

    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target == "/dev/null":
                skip_current = True
                current_path = None
                continue
            skip_current = False
            # Strip the conventional "b/" prefix.
            current_path = target[2:] if target.startswith("b/") else target
            added_by_path.setdefault(current_path, [])
            continue

        if line.startswith("--- "):
            # Old-file header; ignored (path comes from +++).
            continue

        hunk = _HUNK_RE.match(line)
        if hunk:
            new_lineno = int(hunk.group(1))
            continue

        if skip_current or current_path is None:
            continue

        if line.startswith("+"):
            added_by_path[current_path].append(new_lineno)
            new_lineno += 1
        elif line.startswith("-"):
            # Removed line: does not advance the new-file counter.
            continue
        elif line.startswith("\\"):
            # "\ No newline at end of file" — metadata, ignore.
            continue
        else:
            # Context line (leading space) or blank — advances new-file counter.
            new_lineno += 1

    units: list[ChangedUnit] = []
    for path, lines in added_by_path.items():
        if not lines:
            continue
        units.append(ChangedUnit(path=path, added_ranges=_merge_lines(lines)))
    return units


def read_diff(source: str | None) -> str:
    """Return raw unified-diff text from a source.

    ``source == '-'`` reads stdin; a path reads that file; ``None`` runs
    ``git diff`` and falls back to ``git diff --staged`` when the worktree is
    clean. Pure passthrough of text — no parsing here.
    """
    if source == "-":
        return sys.stdin.read()
    if source is not None:
        with open(source, encoding="utf-8") as handle:
            return handle.read()

    unstaged = subprocess.run(
        ["git", "diff"], capture_output=True, text=True, check=False
    ).stdout
    if unstaged.strip():
        return unstaged
    return subprocess.run(
        ["git", "diff", "--staged"], capture_output=True, text=True, check=False
    ).stdout
