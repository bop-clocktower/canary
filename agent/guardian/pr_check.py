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
from dataclasses import dataclass
from pathlib import Path

from agent.guardian.coverage import ChangedUnit, CoverageResult, Fidelity
from agent.guardian.impact_mapper import Severity

_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")

# Suppression annotation: `// canary:allow-untested <reason>` or the `#` variant.
_SUPPRESS_RE = re.compile(r"canary:allow-untested\s+(.+)")


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


@dataclass
class Finding:
    """A single guardian finding about a changed unit.

    Phase 1 emits only ``untested-new-code`` findings (``weak-test`` is a Tier 1+
    concern). ``severity`` reuses :class:`agent.guardian.impact_mapper.Severity`;
    ``fidelity`` carries the confidence tier from the underlying coverage signal.
    """

    path: str
    unit: str
    kind: str = "untested-new-code"
    fidelity: Fidelity = Fidelity.HEURISTIC
    severity: Severity = Severity.HIGH
    evidence: str = ""
    suggestion: str = ""
    suppressed: bool = False
    suppression_reason: str | None = None


def build_findings(results: list[CoverageResult]) -> list[Finding]:
    """Turn uncovered coverage results into fidelity-labeled findings.

    Only **uncovered** results become findings. Severity policy (Phase 1):

      - ``COVERAGE_VERIFIED`` uncovered → ``HIGH``
      - ``GRAPH_VERIFIED`` uncovered    → ``HIGH``
      - ``HEURISTIC`` uncovered         → ``MEDIUM`` (lower confidence)

    Results are sorted by :attr:`Severity.sort_key` (critical → low).
    """
    findings: list[Finding] = []
    for result in results:
        if result.covered:
            continue
        severity = (
            Severity.MEDIUM
            if result.fidelity is Fidelity.HEURISTIC
            else Severity.HIGH
        )
        unit = result.unit
        findings.append(
            Finding(
                path=unit.path,
                unit=unit.symbol or unit.path,
                fidelity=result.fidelity,
                severity=severity,
                evidence=result.evidence,
            )
        )
    return sorted(findings, key=lambda f: f.severity.sort_key)


def apply_suppressions(
    findings: list[Finding], repo_root: Path = Path(".")
) -> list[Finding]:
    """Honor ``canary:allow-untested <reason>`` annotations (SC-12).

    Scans each finding's source file for a ``canary:allow-untested <reason>``
    annotation (both ``//`` and ``#`` comment leaders are accepted). When
    present, the finding is marked ``suppressed`` with its ``suppression_reason``
    captured. Suppressed findings **remain** in the returned list so they stay
    visible in rendered output — only the hard-gate exit calc ignores them.
    """
    for finding in findings:
        try:
            source = (repo_root / finding.path).read_text(encoding="utf-8")
        except OSError:
            continue
        match = _SUPPRESS_RE.search(source)
        if match:
            finding.suppressed = True
            finding.suppression_reason = match.group(1).strip()
    return findings


_HARD_GATE_SEVERITIES = frozenset({Severity.CRITICAL, Severity.HIGH})


def compute_exit_code(findings: list[Finding], gate: str) -> int:
    """Compute the soft/hard gate exit code (SC-4).

    - ``gate == "soft"`` → always ``0``.
    - ``gate == "hard"`` → ``1`` iff any finding is an ``untested-new-code``
      finding of ``CRITICAL``/``HIGH`` severity that is **not addressed**.

    A finding is *addressed* when it is suppressed (SC-12) or when a covering
    test was added in the same diff (in which case it never appears in
    ``findings`` at all — suppressed findings do remain, so the live check is
    simply ``not suppressed``).
    """
    if gate != "hard":
        return 0
    for finding in findings:
        if (
            finding.kind == "untested-new-code"
            and finding.severity in _HARD_GATE_SEVERITIES
            and not finding.suppressed
        ):
            return 1
    return 0
