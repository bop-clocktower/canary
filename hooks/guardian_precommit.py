#!/usr/bin/env python3
"""Git pre-commit surface for canary-pr-guardian — deterministic Tier 0 on the
STAGED diff.

No network, no agent, no LLM (SC-11, enforced by
``test_guardian_capability_boundary.py``): this module imports **no**
``AgentTier``/``agent.llm``/LLM-SDK module and never references the
``analyze_diff``/``get_impact`` MCP tools. The tier ceiling comes from the
agentless :class:`agent.guardian.tier.NoAgentProbe`.

The core logic (:func:`run_precommit_check`) is a **pure, injectable callable** —
it takes the staged diff text and config as arguments and returns a
:class:`PrecommitOutcome`, so it is unit-tested directly without installing a git
hook. The git-hook entrypoint (:func:`main`) is a thin shell around it (T4).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from _harness_dedup import harness_hook_present  # house dedup guard (see plan)

REPO_ROOT = Path(__file__).resolve().parents[1]

GUARDIAN_MARKER = "# canary-guardian-precommit"

# D4 loop-guard (a), Tier-0 half. When the ``canary-pr-guardian`` SKILL authors
# and stages tests it drops this sentinel, then blocks the commit for review. On
# the NEXT commit (the human re-committing the reviewed, staged, guardian-authored
# tests) the hook sees the sentinel and passes the commit through exactly once,
# consuming it — so the guardian never re-authors its own output and never loops.
# This is a FILESYSTEM-ONLY check: it imports no agent module and keeps
# ``guardian_precommit.py`` inside the Tier-0 boundary (SC-11).
_AUTHORED_SENTINEL = ".git/canary-guardian-authored"

# Preserve any prior hook's failure: in POSIX `sh` with no `set -e`, a chained
# script exits with its LAST command's status, so a soft-gate-0 guardian would
# MASK a preceding block (e.g. check-proprietary exiting 1). This guard captures
# the immediately-preceding command's exit and short-circuits with it before the
# guardian runs, so the guardian's exit only governs when nothing blocked first.
_PREV_EXIT_GUARD = '__canary_prev=$?; [ "$__canary_prev" = 0 ] || exit "$__canary_prev"; '


def _guarded_line(command: str) -> str:
    """Build a marker-tagged, exit-preserving pre-commit line for ``command``."""
    return f"{_PREV_EXIT_GUARD}{command}  {GUARDIAN_MARKER}\n"


def requested_tier(config) -> int:
    """Map config to a requested tier.

    Authoring tests is the Tier-2 capability (author + stage). With no agent in
    Phase 3, a tier-2 request degrades to 0 loudly; ``authorTests: false``
    requests tier 0 (no degradation).
    """
    return 2 if config.precommit_author_tests else 0


@dataclass
class PrecommitOutcome:
    """Result of a pre-commit check: exit code, printable report, whether the
    surface was skipped, and any loud tier-degradation notice."""

    exit_code: int
    report: str
    skipped: bool
    degraded_notice: str | None


def run_precommit_check(config, diff_text: str, probe=None) -> PrecommitOutcome:
    """Run the deterministic Tier 0 pipeline on ``diff_text`` (the staged diff).

    Mirrors the PR surface pipeline (``cli.pr_check``): scope → skip/test/
    re-export filters → resolve-coverage → build/suppress findings → text render →
    ``precommit_gate`` exit. Honors ``preCommit.enabled`` (SC-7 skip) and surfaces
    a LOUD degradation notice whenever an authoring request outruns the available
    (agentless) tier (SC-5, pre-commit half).
    """
    # Intra-guardian imports only (SC-11 — no agent/LLM):
    from agent.guardian.coverage import resolve_coverage
    from agent.guardian.pr_check import (
        apply_suppressions,
        build_findings,
        compute_exit_code,
        filter_skipped,
        filter_test_units,
        find_reexport_only,
        render,
        scope_diff,
    )
    from agent.guardian.tier import resolve_tier

    # SC-7: preCommit.enabled == false → skip entirely, exit 0. No diff scoped.
    if not config.precommit_enabled:
        return PrecommitOutcome(
            0, "guardian: preCommit.enabled is false — skipping.", True, None
        )

    # SC-5 (pre-commit half): loud degradation when authoring (tier 2) is asked
    # for but no agent runtime exists.
    resolution = resolve_tier(requested_tier(config), probe)

    # Mirror the PR pipeline exactly (cli.pr_check).
    units = scope_diff(diff_text)
    kept, skipped = filter_skipped(units, config.skip_globs)
    kept, test_units = filter_test_units(kept)
    reexport = find_reexport_only(diff_text)
    barrels = [u for u in kept if u.path in reexport]
    kept = [u for u in kept if u.path not in reexport]
    if not kept:
        n = len(skipped) + len(test_units) + len(barrels)
        # No unit was actually checked, so no tier degradation is claimed here —
        # surfacing a ⚠ notice on a "nothing to verify" report would be a dangling
        # warning about a check that never ran (L1).
        return PrecommitOutcome(
            0,
            f"guardian: nothing to verify ({n} path(s) skipped).",
            False,
            None,
        )

    results = resolve_coverage(kept)  # heuristic/graph fidelity, no report path
    findings = apply_suppressions(build_findings(results))
    report = render(
        findings,
        fmt="text",
        tier=resolution.effective,
        degraded_notice=resolution.degraded_notice,
    )
    exit_code = compute_exit_code(findings, gate=config.precommit_gate)
    return PrecommitOutcome(exit_code, report, False, resolution.degraded_notice)


def _sentinel_path(root: Path) -> Path:
    """Absolute path to the guardian's authored-tests sentinel under ``root``."""
    return root / _AUTHORED_SENTINEL


def authored_recommit_passthrough(root: Path | None = None) -> bool:
    """Loop-guard (a): consume the guardian's sentinel and pass THIS commit once.

    If ``.git/canary-guardian-authored`` is present the human is re-committing
    reviewed, staged, guardian-authored tests, so delete the sentinel and return
    ``True`` (let the commit through without re-running authoring). Absent, return
    ``False`` (normal pipeline). Deterministic, filesystem-only — no agent import.
    """
    sentinel = _sentinel_path(root or REPO_ROOT)
    if sentinel.is_file():
        sentinel.unlink()
        return True
    return False


def staged_diff() -> str:
    """Return `git diff --staged` text ('' when nothing staged).

    This is the ONLY git call in the surface; the core takes the diff injected.
    Fail-open: if ``git`` is not on PATH (``FileNotFoundError``) or otherwise
    unspawnable (``OSError``), return "" so an advisory gate degrades to "nothing
    to verify" instead of blocking the commit with a traceback.
    """
    try:
        return subprocess.run(
            ["git", "diff", "--staged"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    except OSError:
        return ""


def install(repo_root: Path | None = None) -> None:
    """Install the guardian pre-commit hook, CHAINING onto any existing hook.

    ``.git/hooks/pre-commit`` may already be owned by ``check-proprietary.py``, so
    this is collision-aware: if the file exists it APPENDS a marker-guarded
    guardian line (idempotent — a re-install is a no-op when the marker is
    present), never overwriting the existing content; if absent it writes a fresh
    ``#!/bin/sh`` + guardian line.
    """
    root = repo_root or REPO_ROOT
    hook = root / ".git" / "hooks" / "pre-commit"
    line = _guarded_line(f'python3 "{Path(__file__).resolve()}" run')
    if hook.is_file():
        existing = hook.read_text(encoding="utf-8")
        if GUARDIAN_MARKER in existing:
            print("guardian pre-commit already installed.")
            return
        hook.write_text(existing.rstrip("\n") + "\n" + line, encoding="utf-8")
    else:
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\n" + line, encoding="utf-8")
    hook.chmod(0o755)
    print(f"Installed guardian pre-commit hook → {hook}")


def main(argv: list[str] | None = None) -> int:
    """Thin git-hook entrypoint: load config, scope the staged diff, run the
    Tier 0 core, print the report, and return the gate exit code."""
    args = list(sys.argv[1:] if argv is None else argv)
    if "--install" in args:
        install()
        return 0
    # D4 loop-guard (a): if the guardian's own authored tests are being
    # re-committed, pass this commit through once (consuming the sentinel) BEFORE
    # running any coverage pipeline — the guardian never re-authors its own output.
    if authored_recommit_passthrough():
        print("guardian: authored tests re-committed — passing once.")
        return 0
    # Dedup: defer to a harness JS guardian counterpart if one is ever wired
    # (none exists in Phase 3, so this never fires — see plan Assumptions).
    if harness_hook_present("guardian-precommit.js"):
        return 0
    from agent.guardian.pr_check import load_guardian_config

    config, warning = load_guardian_config(REPO_ROOT / "harness.config.json")
    if warning:
        print(f"WARNING: {warning}", file=sys.stderr)
    outcome = run_precommit_check(config, staged_diff())
    if outcome.report:
        print(outcome.report)
    return outcome.exit_code


if __name__ == "__main__":
    sys.exit(main())
