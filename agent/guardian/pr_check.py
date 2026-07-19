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
from agent.guardian.coverage import ChangedUnit, CoverageResult, Fidelity, is_test_path
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
    in_hunk = False

    for line in diff_text.splitlines():
        if line.startswith("diff --git"):
            # New file block begins → leave any prior hunk body; path is set by
            # the upcoming `+++ ` header.
            in_hunk = False
            current_path = None
            skip_current = False
            continue

        # `--- `/`+++ ` are file headers ONLY before the first hunk of a file.
        # Once inside a hunk body a `+++ ...` line is an ADDED content line whose
        # real text is `++ ...` and must not be mistaken for a header (FIX 7).
        if not in_hunk and line.startswith("+++ "):
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

        if not in_hunk and line.startswith("--- "):
            # Old-file header; ignored (path comes from +++).
            continue

        hunk = _HUNK_RE.match(line)
        if hunk:
            new_lineno = int(hunk.group(1))
            in_hunk = True
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


def _glob_matches(path: str, pattern: str) -> bool:
    """Return True iff ``path`` matches a glob ``pattern`` supporting ``**``.

    Translation rules (segment-aware, forward-slash paths):

    - ``**`` matches any number of characters including ``/`` (any depth, incl.
      zero directories). ``docs/**`` matches ``docs/x.md`` and ``docs/a/b.md``;
      a leading ``**/`` also matches zero leading segments so ``**/*.md`` matches
      both ``x.md`` and ``a/b/c.md``.
    - ``*`` matches any run of characters *within a single segment* (no ``/``).
    - ``?`` matches a single non-``/`` character.

    The pattern is anchored to the full path (implicit ``^...$``).
    """
    regex_parts: list[str] = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith("**/", i):
            # `**/` → any leading segments including none.
            regex_parts.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            regex_parts.append(".*")
            i += 2
        elif char == "*":
            regex_parts.append("[^/]*")
            i += 1
        elif char == "?":
            regex_parts.append("[^/]")
            i += 1
        else:
            regex_parts.append(re.escape(char))
            i += 1
    return re.fullmatch("".join(regex_parts), path) is not None


def filter_skipped(
    units: list[ChangedUnit], skip_globs: list[str]
) -> tuple[list[ChangedUnit], list[ChangedUnit]]:
    """Partition ``units`` into ``(kept, skipped)`` by ``skip_globs`` (SC-2).

    A unit is *skipped* iff its ``.path`` matches ANY glob in ``skip_globs``.
    Order-preserving in both partitions. An empty ``skip_globs`` keeps every
    unit (``(units, [])``).
    """
    if not skip_globs:
        return units, []
    kept: list[ChangedUnit] = []
    skipped: list[ChangedUnit] = []
    for unit in units:
        if any(_glob_matches(unit.path, glob) for glob in skip_globs):
            skipped.append(unit)
        else:
            kept.append(unit)
    return kept, skipped


def filter_test_units(
    units: list[ChangedUnit],
) -> tuple[list[ChangedUnit], list[ChangedUnit]]:
    """Partition ``units`` into ``(kept, test_units)`` by test-path (FIX A).

    A test file does not itself need a test, so a changed unit whose path looks
    like a test (``tests/**``, ``test_*.py``, ``*.test.*``, ``*.spec.*`` — the
    single :func:`agent.guardian.coverage.is_test_path` predicate reused by the
    graph resolver) is dropped before findings are built. Order-preserving in
    both partitions. Importing ``is_test_path`` from the sibling ``coverage``
    module is an intra-guardian import, not an agent/LLM import (SC-11 intact).
    """
    kept: list[ChangedUnit] = []
    test_units: list[ChangedUnit] = []
    for unit in units:
        if is_test_path(unit.path):
            test_units.append(unit)
        else:
            kept.append(unit)
    return kept, test_units


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

    The gate is normalized (``strip().lower()``) before the comparison so a
    mistyped ``"Hard"`` / ``" hard "`` still enforces rather than silently
    failing open (FIX 5). Config-load validation (:func:`load_guardian_config`)
    is the primary guard against unknown gate values.
    """
    normalized_gate = gate.strip().lower() if isinstance(gate, str) else gate
    if normalized_gate != "hard":
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


# SC-2 canonical skip set: files no coverage gate should ever fire on. Docs and
# markdown never need a covering test; generated/dependency artifacts (lockfiles,
# built bundles under dist/build, minified JS, test snapshots) are not authored
# code and would only produce noise (signal-quality FIX 1, seen dogfooding on an
# external repo where package-lock.json was falsely flagged). This is the DEFAULT
# skip set when a config omits ``skipGlobs`` entirely — an explicit ``skipGlobs``
# (even ``[]``) overrides it. See ``load_guardian_config``.
_DEFAULT_SKIP_GLOBS = (
    "docs/**",
    "**/*.md",
    # Dependency lockfiles (generated, never hand-tested).
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/poetry.lock",
    "**/Cargo.lock",
    "**/*.lock",
    # Build outputs and generated bundles/snapshots.
    "dist/**",
    "build/**",
    "**/*.min.js",
    "**/*.snap",
)


@dataclass
class GuardianConfig:
    """Parsed ``canary.guardian`` config block.

    Phase 1 stores every field but only ``pr_*`` gate/tier drive behavior.
    ``skip_globs`` and the ``precommit_*``/``coverage_paths`` fields are read
    into the object (scaffold) for later phases (SC-2 skip, SC-5 tier).

    ``skip_globs`` defaults to docs/markdown PLUS generated/dependency artifacts
    (lockfiles, ``dist``/``build`` outputs, minified JS, snapshots — see
    ``_DEFAULT_SKIP_GLOBS``) so noise-only paths skip out of the box; an explicit
    ``skipGlobs`` in config (even ``[]``) overrides it.
    """

    pr_enabled: bool = True
    pr_tier: int = 0
    pr_gate: str = "soft"
    precommit_enabled: bool = False
    precommit_author_tests: bool = True
    precommit_gate: str = "soft"
    coverage_paths: list[str] = field(default_factory=list)
    skip_globs: list[str] = field(default_factory=lambda: list(_DEFAULT_SKIP_GLOBS))


_VALID_GATES = frozenset({"soft", "hard"})


def _coerce_tier(raw: object, default: int, warnings: list[str]) -> int:
    """Coerce a config ``tier`` to an int, warning + defaulting on bad input.

    A plain int is taken as-is; a clean integer string (``"2"``) is accepted;
    anything else (``"medium"``, ``1.5``, ``[]``, ``True``) warns and defaults —
    never raises (FIX 4, SC-8).
    """
    if isinstance(raw, bool):
        warnings.append(f"guardian pr.tier must be an integer, got {raw!r}; using {default}")
        return default
    if isinstance(raw, int):
        return raw
    try:
        return int(str(raw).strip())
    except (ValueError, TypeError):
        warnings.append(f"guardian pr.tier must be an integer, got {raw!r}; using {default}")
        return default


def _coerce_gate(raw: object, default: str, field_name: str, warnings: list[str]) -> str:
    """Validate a config gate against ``{soft, hard}``, warning + defaulting.

    Normalizes case/whitespace; anything outside the set warns and defaults
    (FIX 4/FIX 5 — an unknown gate must never silently disable enforcement).
    """
    normalized = str(raw).strip().lower()
    if normalized in _VALID_GATES:
        return normalized
    warnings.append(
        f"guardian {field_name} must be 'soft' or 'hard', got {raw!r}; using {default}"
    )
    return default


def load_guardian_config(
    config_path: Path = Path("harness.config.json"),
) -> tuple[GuardianConfig, str | None]:
    """Load the ``canary.guardian`` block, distinguishing absent from malformed.

    Uses :func:`read_json_with_warning`. Returns ``(GuardianConfig, warning)``:

      - file absent                    → ``(defaults, None)``  (silent, normal)
      - malformed JSON                 → ``(defaults, "<warn>")`` (LOUD, SC-8)
      - valid but no ``canary.guardian`` → ``(defaults, None)``
      - valid ``canary.guardian``      → ``(parsed, None)``
      - valid block, bad ``tier``/``gate`` → ``(defaults for those fields,
        "<warn>")`` — coercion never raises and the warning rides the same loud
        slot the CLI echoes (FIX 4).
    """
    data, warning = read_json_with_warning(Path(config_path))
    if warning is not None or not isinstance(data, dict):
        return GuardianConfig(), warning

    block = data.get("canary", {})
    block = block.get("guardian", {}) if isinstance(block, dict) else {}
    if not isinstance(block, dict) or not block:
        return GuardianConfig(), None

    config = GuardianConfig()
    warnings: list[str] = []
    pr = block.get("pr", {})
    if isinstance(pr, dict):
        config.pr_enabled = bool(pr.get("enabled", config.pr_enabled))
        if "tier" in pr:
            config.pr_tier = _coerce_tier(pr["tier"], config.pr_tier, warnings)
        if "gate" in pr:
            config.pr_gate = _coerce_gate(pr["gate"], config.pr_gate, "pr.gate", warnings)

    precommit = block.get("preCommit", {})
    if isinstance(precommit, dict):
        config.precommit_enabled = bool(
            precommit.get("enabled", config.precommit_enabled)
        )
        config.precommit_author_tests = bool(
            precommit.get("authorTests", config.precommit_author_tests)
        )
        if "gate" in precommit:
            config.precommit_gate = _coerce_gate(
                precommit["gate"], config.precommit_gate, "preCommit.gate", warnings
            )

    coverage_paths = block.get("coveragePaths")
    if isinstance(coverage_paths, list):
        config.coverage_paths = [str(p) for p in coverage_paths]

    # FIX B: only override the default (docs/** + **/*.md) when skipGlobs is
    # PRESENT. `block.get("skipGlobs")` is None iff the key is ABSENT → keep the
    # default; an explicit list (including empty []) is honored verbatim so a
    # deliberate `skipGlobs: []` means "skip nothing".
    skip_globs = block.get("skipGlobs")
    if isinstance(skip_globs, list):
        config.skip_globs = [str(g) for g in skip_globs]

    return config, ("; ".join(warnings) if warnings else None)
