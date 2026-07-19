"""Tier 0 deterministic PR guardian engine.

Scopes a git diff into changed units, resolves diff-coverage at the highest
available fidelity (see :mod:`agent.guardian.coverage`), builds fidelity-labeled
findings, honors ``canary:allow-untested`` suppressions, renders output, and
computes a soft/hard gate exit code.

SC-11 boundary: imports **no** ``AgentTier``/LLM/agent module and never
references the ``analyze_diff``/``get_impact`` MCP tools.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from agent.core.config_validation import read_json_with_warning
from agent.guardian.coverage import ChangedUnit, CoverageResult, Fidelity
from agent.guardian.impact_mapper import Severity

_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")

# Suppression annotation: `// canary:allow-untested <reason>` or the `#` variant.
# A comment leader (`//` or `#`) is REQUIRED immediately before the token so a
# bare occurrence inside a string literal, docstring, or prose never clears the
# gate (FIX 1).
_SUPPRESS_RE = re.compile(r"(?://|#)\s*canary:allow-untested\s+(.+)")

# Trailing inline-comment closers stripped from a captured reason.
_INLINE_COMMENT_CLOSERS = ("*/", "-->")


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
    # Inclusive 1-based (start, end) ranges the diff ADDED for this unit. Carried
    # from the ``CoverageResult``/``ChangedUnit`` so suppression can be scoped to
    # only the changed lines (FIX 1). Empty → suppression falls back to a
    # whole-file scan (still comment-leader gated).
    added_ranges: list[tuple[int, int]] = field(default_factory=list)


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
                added_ranges=list(unit.added_ranges),
            )
        )
    return sorted(findings, key=lambda f: f.severity.sort_key)


def _lines_in_ranges(ranges: list[tuple[int, int]]) -> list[int]:
    """Flatten inclusive ``(start, end)`` ranges into a sorted list of line numbers."""
    lines: set[int] = set()
    for start, end in ranges:
        lines.update(range(start, end + 1))
    return sorted(lines)


def _suppression_reason(line: str) -> str | None:
    """Return the captured reason iff ``line`` carries a comment-led annotation.

    Requires a ``//``/``#`` comment leader (FIX 1), strips a trailing
    inline-comment close (e.g. ``*/``), and trims surrounding whitespace.
    """
    match = _SUPPRESS_RE.search(line)
    if match is None:
        return None
    reason = match.group(1)
    for closer in _INLINE_COMMENT_CLOSERS:
        idx = reason.find(closer)
        if idx != -1:
            reason = reason[:idx]
    return reason.strip()


def apply_suppressions(
    findings: list[Finding], repo_root: Path = Path(".")
) -> list[Finding]:
    """Honor ``canary:allow-untested <reason>`` annotations (SC-12).

    Scans the finding's source **only within the unit's added line ranges** for a
    comment-led ``canary:allow-untested <reason>`` annotation (both ``//`` and
    ``#`` leaders accepted). A bare occurrence inside a string literal, docstring,
    or an untouched line therefore never clears the gate (FIX 1). When the
    finding carries no ``added_ranges`` the scan falls back to the whole file
    (still comment-leader gated). Suppressed findings **remain** in the returned
    list so they stay visible in rendered output — only the hard-gate exit calc
    ignores them.
    """
    for finding in findings:
        try:
            source = (repo_root / finding.path).read_text(encoding="utf-8")
        except OSError:
            continue
        source_lines = source.splitlines()
        if finding.added_ranges:
            candidates = _lines_in_ranges(finding.added_ranges)
        else:
            candidates = range(1, len(source_lines) + 1)
        for lineno in candidates:
            if not 1 <= lineno <= len(source_lines):
                continue
            reason = _suppression_reason(source_lines[lineno - 1])
            if reason is not None:
                finding.suppressed = True
                finding.suppression_reason = reason
                break
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


_STICKY_MARKER = "<!-- canary-pr-guardian -->"


def _finding_dict(finding: Finding) -> dict:
    """Serialize a :class:`Finding` to a stable JSON-friendly dict."""
    return {
        "path": finding.path,
        "unit": finding.unit,
        "kind": finding.kind,
        "fidelity": finding.fidelity.value,
        "severity": finding.severity.value,
        "evidence": finding.evidence,
        "suggestion": finding.suggestion,
        "suppressed": finding.suppressed,
        "suppression_reason": finding.suppression_reason,
    }


def render(
    findings: list[Finding],
    fmt: str,
    tier: int = 0,
    degraded_notice: str | None = None,
) -> str:
    """Render findings as a sticky PR ``comment``, ``json``, or plain ``text``.

    - ``comment``: leads with the sticky marker ``<!-- canary-pr-guardian -->``,
      a fidelity-labeled summary line, then severity-ranked findings (each
      showing path/unit, severity, fidelity, evidence). Suppressed findings are
      rendered but visually marked ``suppressed``. Footer states ``tier 0`` and
      appends ``degraded_notice`` when present.
    - ``json``: ``{"findings": [...], "tier": <n>}`` — stable schema.
    - ``text``: plain, markdown-free, for local/CLI output.
    """
    ordered = sorted(findings, key=lambda f: f.severity.sort_key)

    if fmt == "json":
        payload: dict = {
            "findings": [_finding_dict(f) for f in ordered],
            "tier": tier,
        }
        if degraded_notice:
            payload["degraded_notice"] = degraded_notice
        return json.dumps(payload, indent=2)

    active = [f for f in ordered if not f.suppressed]
    suppressed = [f for f in ordered if f.suppressed]

    if fmt == "comment":
        lines = [_STICKY_MARKER, "## Canary PR Guardian"]
        lines.append(
            f"**{len(active)} unaddressed** / {len(suppressed)} suppressed "
            f"finding(s) — fidelity-labeled below."
        )
        for finding in ordered:
            mark = " _(suppressed)_" if finding.suppressed else ""
            lines.append(
                f"- **{finding.severity.value}** `{finding.path}` "
                f"({finding.unit}) — _{finding.fidelity.value}_ — "
                f"{finding.evidence}{mark}"
            )
        footer = f"_tier {tier}_"
        if degraded_notice:
            footer += f" — {degraded_notice}"
        lines.append(footer)
        return "\n".join(lines)

    # fmt == "text" (default fallback): plain, no markdown/HTML.
    lines = [
        f"Canary PR Guardian — {len(active)} unaddressed, "
        f"{len(suppressed)} suppressed"
    ]
    for finding in ordered:
        mark = " (suppressed)" if finding.suppressed else ""
        lines.append(
            f"[{finding.severity.value}] {finding.path} ({finding.unit}) "
            f"[{finding.fidelity.value}] {finding.evidence}{mark}"
        )
    footer = f"tier {tier}"
    if degraded_notice:
        footer += f" - {degraded_notice}"
    lines.append(footer)
    return "\n".join(lines)


@dataclass
class GuardianConfig:
    """Parsed ``canary.guardian`` config block.

    Phase 1 stores every field but only ``pr_*`` gate/tier drive behavior.
    ``skip_globs`` and the ``precommit_*``/``coverage_paths`` fields are read
    into the object (scaffold) for later phases (SC-2 skip, SC-5 tier).
    """

    pr_enabled: bool = True
    pr_tier: int = 0
    pr_gate: str = "soft"
    precommit_enabled: bool = False
    precommit_author_tests: bool = True
    precommit_gate: str = "soft"
    coverage_paths: list[str] = field(default_factory=list)
    skip_globs: list[str] = field(default_factory=list)


def load_guardian_config(
    config_path: Path = Path("harness.config.json"),
) -> tuple[GuardianConfig, str | None]:
    """Load the ``canary.guardian`` block, distinguishing absent from malformed.

    Uses :func:`read_json_with_warning`. Returns ``(GuardianConfig, warning)``:

      - file absent                    → ``(defaults, None)``  (silent, normal)
      - malformed JSON                 → ``(defaults, "<warn>")`` (LOUD, SC-8)
      - valid but no ``canary.guardian`` → ``(defaults, None)``
      - valid ``canary.guardian``      → ``(parsed, None)``
    """
    data, warning = read_json_with_warning(Path(config_path))
    if warning is not None or not isinstance(data, dict):
        return GuardianConfig(), warning

    block = data.get("canary", {})
    block = block.get("guardian", {}) if isinstance(block, dict) else {}
    if not isinstance(block, dict) or not block:
        return GuardianConfig(), None

    config = GuardianConfig()
    pr = block.get("pr", {})
    if isinstance(pr, dict):
        config.pr_enabled = bool(pr.get("enabled", config.pr_enabled))
        config.pr_tier = int(pr.get("tier", config.pr_tier))
        config.pr_gate = str(pr.get("gate", config.pr_gate))

    precommit = block.get("preCommit", {})
    if isinstance(precommit, dict):
        config.precommit_enabled = bool(
            precommit.get("enabled", config.precommit_enabled)
        )
        config.precommit_author_tests = bool(
            precommit.get("authorTests", config.precommit_author_tests)
        )
        config.precommit_gate = str(precommit.get("gate", config.precommit_gate))

    coverage_paths = block.get("coveragePaths")
    if isinstance(coverage_paths, list):
        config.coverage_paths = [str(p) for p in coverage_paths]

    skip_globs = block.get("skipGlobs")
    if isinstance(skip_globs, list):
        config.skip_globs = [str(g) for g in skip_globs]

    return config, None
