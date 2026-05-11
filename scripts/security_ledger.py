#!/usr/bin/env python3
"""Regenerate docs/SECURITY_LEDGER.md and trim the security timeline.

The harness CLI appends a snapshot to .harness/security/timeline.json on
every security scan. Left alone, the file grows without bound. This
script does two things:

1. Trim timeline.json to the most recent TIMELINE_MAX_SNAPSHOTS
   snapshots (lifecycles are kept in full — they are bounded by the
   number of distinct findings, not by scan frequency).
2. Render a short human-readable summary at docs/SECURITY_LEDGER.md.

Both outputs are deterministic given the same input. Run with no
arguments; CI invokes the script and fails the PR if `git diff
--exit-code` is dirty afterwards (the freshness guard).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TIMELINE = REPO_ROOT / ".harness" / "security" / "timeline.json"
LEDGER = REPO_ROOT / "docs" / "SECURITY_LEDGER.md"
SNAPSHOT_WINDOW = 10
TIMELINE_MAX_SNAPSHOTS = 30


def load_timeline() -> dict:
    if not TIMELINE.exists():
        return {"snapshots": [], "findingLifecycles": []}
    return json.loads(TIMELINE.read_text())


def fmt_snapshot_row(s: dict) -> str:
    sev = s.get("bySeverity", {})
    sc = s.get("supplyChain", {})
    return (
        f"| {s.get('capturedAt', '?')[:19]} "
        f"| `{(s.get('commitHash') or '')[:7]}` "
        f"| {s.get('securityScore', '?')} "
        f"| {s.get('totalFindings', 0)} "
        f"| {sev.get('error', 0)}/{sev.get('warning', 0)}/{sev.get('info', 0)} "
        f"| {sc.get('total', 0)} |"
    )


def render(data: dict) -> str:
    snapshots = data.get("snapshots", [])
    lifecycles = data.get("findingLifecycles", [])

    latest = snapshots[-1] if snapshots else None
    window = snapshots[-SNAPSHOT_WINDOW:] if snapshots else []
    open_findings = [f for f in lifecycles if not f.get("resolvedAt")]
    resolved_count = sum(1 for f in lifecycles if f.get("resolvedAt"))

    lines: list[str] = []
    lines.append("# Security Ledger")
    lines.append("")
    lines.append(
        "Auto-generated summary of `.harness/security/timeline.json`."
    )
    lines.append(
        "Do not edit by hand — run `python scripts/security_ledger.py`"
    )
    lines.append("to refresh.")
    lines.append("")

    lines.append("## Latest Snapshot")
    lines.append("")
    if latest is None:
        lines.append("_No scans recorded yet._")
    else:
        sev = latest.get("bySeverity", {})
        sc = latest.get("supplyChain", {})
        lines.append(f"- **Captured:** {latest.get('capturedAt', '?')}")
        lines.append(
            f"- **Commit:** `{(latest.get('commitHash') or '')[:12]}`"
        )
        lines.append(f"- **Score:** {latest.get('securityScore', '?')}")
        lines.append(
            f"- **Findings:** {latest.get('totalFindings', 0)} "
            f"(error: {sev.get('error', 0)}, "
            f"warning: {sev.get('warning', 0)}, "
            f"info: {sev.get('info', 0)})"
        )
        lines.append(
            f"- **Supply chain:** {sc.get('total', 0)} "
            f"(critical: {sc.get('critical', 0)}, "
            f"high: {sc.get('high', 0)}, "
            f"moderate: {sc.get('moderate', 0)}, "
            f"low: {sc.get('low', 0)})"
        )
        lines.append(
            f"- **Suppressions:** {latest.get('suppressionCount', 0)}"
        )
    lines.append("")

    lines.append(f"## Recent Snapshots (last {SNAPSHOT_WINDOW})")
    lines.append("")
    if not window:
        lines.append("_No snapshots._")
    else:
        lines.append(
            "| Captured | Commit | Score | Findings | Err/Warn/Info | Supply |"
        )
        lines.append(
            "| --- | --- | ---: | ---: | --- | ---: |"
        )
        for s in window:
            lines.append(fmt_snapshot_row(s))
    lines.append("")

    lines.append("## Open Findings")
    lines.append("")
    if not open_findings:
        lines.append("_None._")
    else:
        for f in open_findings:
            lines.append(
                f"- **{f.get('ruleId', '?')}** "
                f"({f.get('severity', '?')}, {f.get('category', '?')}) — "
                f"`{f.get('file', '?')}` "
                f"first seen {f.get('firstSeenAt', '?')[:19]}"
            )
    lines.append("")

    lines.append("## Stats")
    lines.append("")
    lines.append(f"- Total snapshots recorded: {len(snapshots)}")
    lines.append(f"- Findings resolved (lifetime): {resolved_count}")
    lines.append(f"- Findings open: {len(open_findings)}")
    lines.append("")

    return "\n".join(lines)


def trim_timeline(data: dict) -> dict:
    snapshots = data.get("snapshots", [])
    if len(snapshots) > TIMELINE_MAX_SNAPSHOTS:
        data["snapshots"] = snapshots[-TIMELINE_MAX_SNAPSHOTS:]
    return data


def main() -> int:
    data = load_timeline()
    data = trim_timeline(data)
    if TIMELINE.exists():
        TIMELINE.write_text(json.dumps(data, indent=2) + "\n")
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
