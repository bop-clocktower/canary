#!/usr/bin/env python3
"""Fail if live docs/examples reference surfaces that were removed in a refactor.

The v3.0 rollout deleted the `agent/llm/` provider layer, the in-process
orchestrator, and the keyed `generate` CLI command — but the docs kept
referencing them for months. This guard makes that class of drift a hard CI
failure: when a command, module, or env var is removed, its name must stop
appearing in user-facing docs and examples in the same change.

Scope
-----
Only **live usage surfaces** are scanned (see INCLUDE_PATHS): the things a
user or contributor reads to learn how the tool works *today*. Deliberately
NOT scanned:
  - historical records: docs/adr, docs/plans, docs/specs, docs/changes,
    docs/archive, docs/roadmap.md, docs/CANARY_STATE.md, docs/CANARY_LEARNINGS.md
  - generated artifacts and test fixtures: tests/
  - session memory: .remember/

Escape hatches
--------------
  - A whole file is skipped if it is a *removal-note doc* — its first lines
    contain "removed in v3" (e.g. the LLM-Providers wiki page now redirects).
  - A single line is skipped if it contains a removal-note phrase
    (see ALLOWED_CONTEXT_SUBSTRINGS), so prose can explain a removal inline.

Maintaining it
--------------
Append a (pattern, reason) row to REMOVED_SYMBOLS whenever you delete a
command, module, or env var. That one line turns the deletion into an
enforced doc contract.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# (regex, human reason) — surfaces removed in v3.0.
REMOVED_SYMBOLS: list[tuple[str, str]] = [
    (r"\bcanary generate\b", "the `generate` CLI command was removed in v3.0 — use the /canary-write-test plugin command"),
    (r"\boracle generate\b", "the `generate` CLI command was removed in v3.0 — use the /canary-write-test plugin command"),
    (r"\b(CANARY|ORACLE)_LLM_PROVIDER\b", "the LLM provider layer (agent/llm/) was removed in v3.0 — no provider env var exists"),
    (r"\bProviderFactory\b", "the LLM provider layer was removed in v3.0"),
    (r"\bset your API key\b", "no API key is required — LLM work runs through the Claude Code session"),
]

# Live usage surfaces that must describe the tool as it works today.
INCLUDE_PATHS = (
    "README.md", "AGENTS.md", "CLAUDE.md",
    "docs/wiki", "docs/guides",
    "examples", "agents", "agent",
)

# Proprietary content must NOT appear anywhere in this public, open-source repo.
# Company-specific material belongs in a PRIVATE overlay (discovered at runtime
# via .canary/skills/), never upstream.
#
# This is deliberately split so the PUBLIC script names no company:
#   1. GENERIC structural patterns (below) — name nobody; safe to ship public.
#   2. A company-specific DENYLIST loaded at runtime from, in order:
#        - env var CANARY_PROPRIETARY_DENYLIST (comma-separated terms), and/or
#        - a gitignored file `.proprietary-denylist` (one term/regex per line).
#      The denylist itself is never committed, so the actual names stay private.
#      In CI, supply it via a repo secret exported to CANARY_PROPRIETARY_DENYLIST.
#      With no denylist configured, only the generic patterns run.
GENERIC_PROPRIETARY_PATTERNS: list[tuple[str, str]] = [
    (r"(?i)\b[\w-]+\.internal\b", "internal hostname — internal infra references must not appear in public source"),
    (r"(?i)\bCONFIDENTIAL\b", "'confidential' marker — proprietary content does not belong in the public repo"),
]

DENYLIST_FILE = ".proprietary-denylist"
DENYLIST_ENV = "CANARY_PROPRIETARY_DENYLIST"

# The proprietary scan is repo-wide (company names can hide anywhere), minus
# history and generated/vendor trees.
PROPRIETARY_EXCLUDED_DIRS = {
    ".git", ".venv", "node_modules", "__pycache__",
    "docs/archive", "tests/generated", ".remember",
}
PROPRIETARY_SUFFIXES = {".md", ".py", ".json", ".svg", ".html", ".yml", ".yaml", ".txt", ".toml"}

# A line mentioning a removed symbol is allowed if it is clearly explaining
# the removal rather than instructing the reader to use it.
ALLOWED_CONTEXT_SUBSTRINGS = (
    "removed in v3", "was removed", "no longer exists", "has been deleted",
    "deleted in v3", "predates v3", "out of date", "vestigial",
    "not currently wired", "removal note", "no api key", "no provider",
)

SCANNED_SUFFIXES = {".md", ".py"}
SELF = "scripts/check_removed_symbols.py"


def _in_scope(path: Path) -> bool:
    rel = path.relative_to(REPO_ROOT).as_posix()
    if "__pycache__" in rel:
        return False
    return any(rel == inc or rel.startswith(inc + "/") or rel == inc for inc in INCLUDE_PATHS)


def _is_removal_note_doc(text: str) -> bool:
    """True if the file's opening declares it a removal note."""
    head = "\n".join(text.splitlines()[:8]).lower()
    return "removed in v3" in head


def _check_removed_symbols() -> list[str]:
    """Removed surfaces must not be referenced on live usage docs."""
    patterns = [(re.compile(p), reason) for p, reason in REMOVED_SYMBOLS]
    violations: list[str] = []
    candidates = set()
    for inc in INCLUDE_PATHS:
        p = REPO_ROOT / inc
        if p.is_file():
            candidates.add(p)
        elif p.is_dir():
            candidates.update(q for q in p.rglob("*") if q.suffix in SCANNED_SUFFIXES)

    for path in sorted(candidates):
        if not path.is_file() or path.suffix not in SCANNED_SUFFIXES or not _in_scope(path):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if _is_removal_note_doc(text):
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        for lineno, line in enumerate(text.splitlines(), 1):
            low = line.lower()
            if any(ctx in low for ctx in ALLOWED_CONTEXT_SUBSTRINGS):
                continue
            for rx, reason in patterns:
                if rx.search(line):
                    violations.append(f"{rel}:{lineno}: {line.strip()}\n    → {reason}")
    return violations


def _prop_excluded(path: Path) -> bool:
    rel = path.relative_to(REPO_ROOT).as_posix()
    return any(rel == d or rel.startswith(d + "/") for d in PROPRIETARY_EXCLUDED_DIRS)


def _tracked_files() -> list[str]:
    """Git-tracked paths only — the guard checks what is actually published,
    not local scratch/state files (which may be gitignored)."""
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=REPO_ROOT,
            capture_output=True, text=True, check=True,
        ).stdout
        return [p for p in out.splitlines() if p]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []


def _load_denylist() -> list[tuple[re.Pattern, str]]:
    """Company-specific terms from the gitignored file and/or env var.

    Terms are matched case-insensitively as whole words. Lines starting with #
    in the file are comments. Returns compiled (pattern, reason) pairs.
    """
    import os
    terms: set[str] = set()
    f = REPO_ROOT / DENYLIST_FILE
    if f.is_file():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                terms.add(s)
    for s in os.environ.get(DENYLIST_ENV, "").split(","):
        s = s.strip()
        if s:
            terms.add(s)
    reason = (
        "company/proprietary identifier (from denylist) — keep it in the "
        "private overlay; use a neutral placeholder (e.g. ACME) in public examples"
    )
    return [(re.compile(rf"(?i)\b{re.escape(t)}\b"), reason) for t in sorted(terms)]


def _check_proprietary() -> list[str]:
    """Company/proprietary identifiers must not appear in the public (tracked) repo."""
    patterns = [(re.compile(p), reason) for p, reason in GENERIC_PROPRIETARY_PATTERNS]
    patterns += _load_denylist()
    violations: list[str] = []
    for rel in sorted(_tracked_files()):
        if rel == SELF:
            continue
        path = REPO_ROOT / rel
        if path.suffix not in PROPRIETARY_SUFFIXES or not path.is_file() or _prop_excluded(path):
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            for rx, reason in patterns:
                if rx.search(line):
                    violations.append(f"{rel}:{lineno}: {line.strip()}\n    → {reason}")
    return violations


def main() -> int:
    removed = _check_removed_symbols()
    proprietary = _check_proprietary()

    if removed:
        print("Removed-symbol references found on live surfaces:\n")
        print("\n".join(removed))
        print(
            "\nEach line references something deleted in a refactor. Update it "
            "to the current surface, or — if the line explains the removal — "
            "phrase it as a removal note (e.g. 'removed in v3')."
        )
    if proprietary:
        print("\nProprietary/company identifiers found in the public repo:\n")
        print("\n".join(proprietary))
        print(
            "\nThis repo is public/open-source. Company-specific content belongs "
            "in a PRIVATE overlay (discovered at runtime via .canary/skills/), "
            "never upstream. Use a neutral placeholder (e.g. ACME) in examples."
        )

    if removed or proprietary:
        return 1

    print("check_removed_symbols: clean — no removed-symbol or proprietary leaks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
