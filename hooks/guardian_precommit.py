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

from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


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
        return PrecommitOutcome(
            0,
            f"guardian: nothing to verify ({n} path(s) skipped).",
            False,
            resolution.degraded_notice,
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
