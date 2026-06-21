"""Build the Phase 1 impact summary Markdown.

This is the content posted as a PR comment on the SUT repo after a merge to main.
Pure function: takes gaps and metadata, returns Markdown string.
"""

from __future__ import annotations

from agent.guardian.diff_extractor import ChangeType
from agent.guardian.impact_mapper import ImpactGap, Severity


_SEVERITY_EMOJI = {
    Severity.CRITICAL: "🔴",
    Severity.HIGH: "🟠",
    Severity.MEDIUM: "🟡",
    Severity.LOW: "🟢",
}


def build_summary(
    gaps: list[ImpactGap],
    commit_sha: str,
    suite: str,
    health_snapshot: str = "",
) -> str:
    short_sha = commit_sha[:8]

    if not gaps:
        return (
            f"## Canary Guardian — Test Impact Summary\n\n"
            f"**Commit:** {short_sha}  \n"
            f"**Suite:** {suite}\n\n"
            f"✅ No test impact detected — all existing endpoints and coverage are unchanged.\n"
        )

    added = [g for g in gaps if g.change_type == ChangeType.ADDED]
    removed = [g for g in gaps if g.change_type == ChangeType.REMOVED]
    changed = [g for g in gaps if g.change_type == ChangeType.CHANGED]

    lines = [
        "## Canary Guardian — Test Impact Summary\n",
        f"**Commit:** {short_sha}  \n**Suite:** {suite}\n",
    ]

    if added:
        lines.append("### New endpoints (not yet covered)")
        for g in added:
            sev = _SEVERITY_EMOJI[g.severity]
            cov = f"{len(g.affected_tests)} existing test(s)" if g.affected_tests else "**no existing tests**"
            lines.append(f"- {sev} `{g.method.upper()} {g.path}` — {cov}")
        lines.append("")

    if removed:
        lines.append("### Removed endpoints")
        for g in removed:
            sev = _SEVERITY_EMOJI[g.severity]
            lines.append(f"- {sev} `{g.method.upper()} {g.path}`")
            for t in g.affected_tests[:5]:
                lines.append(f"  - Affected test: _{t}_")
            if len(g.affected_tests) > 5:
                lines.append(f"  - … and {len(g.affected_tests) - 5} more")
        lines.append("")

    if changed:
        lines.append("### Changed endpoints")
        for g in changed:
            sev = _SEVERITY_EMOJI[g.severity]
            lines.append(f"- {sev} `{g.method.upper()} {g.path}`")
            for t in g.affected_tests[:5]:
                lines.append(f"  - Affected test: _{t}_")
        lines.append("")

    if health_snapshot:
        lines.append("### Current health (affected areas)")
        lines.append(health_snapshot)
        lines.append("")

    lines.append("### Recommended actions")
    for i, g in enumerate(gaps[:10], 1):
        if g.change_type == ChangeType.ADDED:
            action = f"Write test for `{g.method.upper()} {g.path}` (no coverage)"
        elif g.change_type == ChangeType.REMOVED:
            action = f"Remove/update tests for `{g.method.upper()} {g.path}` (will break)"
        else:
            action = f"Review tests for `{g.method.upper()} {g.path}` (silent contract drift risk)"
        lines.append(f"{i}. {action}")

    return "\n".join(lines) + "\n"
