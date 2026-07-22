#!/usr/bin/env python3
"""canary-katana -- quarantine deleted and newly-skipped tests, with provenance.

Captures every removed or skipped test into an append-only ledger (who deleted
it, when, in which commit, and why), and alarms in exactly one case: the removed
test was the last coverage of a symbol ``critical-areas.json`` marks high-risk.

Advisory by default (always exit 0). ``--strict`` exits 1 only on a real alarm;
a degraded run (no critical-area data) stays exit 0 even under ``--strict`` --
a gate that fails on missing data gets muted, and a muted gate is worse than
none.

Invoked via `canary skills run canary-katana -- [options]`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import alarm  # noqa: E402
import diffscan  # noqa: E402
import ledger  # noqa: E402

_PREFIX = "canary-katana:"


def _load_diff(repo: Path, diff_file: str | None) -> tuple[str, str | None]:
    """Return (diff_text, base). ``base`` is a git ref when one is resolvable.

    With ``--diff-file`` the diff is read verbatim and git is still consulted
    (best-effort) for provenance; without it the diff is computed from the
    repo's own history.
    """
    if diff_file:
        path = Path(diff_file)
        if not path.exists():
            raise FileNotFoundError(f"diff file not found: {diff_file}")
        text = path.read_text(encoding="utf-8")
        base = None
        try:
            base = diffscan.resolve_base(repo, None)
        except Exception:  # noqa: BLE001 - non-git repo: provenance stays unknown
            base = None
        return text, base

    base = diffscan.resolve_base(repo, None)
    return diffscan.diff_text(repo, base), base


def _provenance(repo: Path, base: str | None, file: str):
    if base is None:
        return None
    try:
        return diffscan.commit_for_file(repo, base, file)
    except Exception:  # noqa: BLE001 - missing history is unknown, not fatal
        return None


def _to_entries(repo: Path, base: str | None, deletions) -> list:
    entries = []
    for deletion in deletions:
        commit = _provenance(repo, base, deletion.file)
        entries.append(
            ledger.LedgerEntry(
                test=deletion.name,
                file=deletion.file,
                kind=deletion.kind.value,
                marker=deletion.marker,
                commit=commit.sha if commit else "",
                author=commit.author if commit else "unknown",
                date=commit.date if commit else "",
                reason=commit.subject if commit else "",
            )
        )
    return entries


def _render_text(deletions, findings, degraded: bool) -> str:
    count = len(deletions)
    lines = [f"{count} deletion(s) captured."]
    if degraded:
        lines.append(alarm.DEGRADED_NOTICE)
    for f in findings:
        lines.append(
            f"  [{f.severity.value}] {f.file}::{f.test} removed the last coverage "
            f"of {f.area}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-katana",
        description="Quarantine deleted/skipped tests and alarm on last-coverage loss.",
    )
    parser.add_argument("--repo", default=".", help="Repository root (default: .).")
    parser.add_argument("--diff-file", help="Read the diff from this file instead of git.")
    parser.add_argument("--ledger", help="Ledger path (default: <repo>/.canary/quarantine.json).")
    parser.add_argument("--critical-areas", help="Path to critical-areas.json.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--strict", action="store_true", help="Exit 1 on a real alarm.")
    parser.add_argument("--no-write", action="store_true", help="Do not write the ledger.")
    args = parser.parse_args(argv)

    repo = Path(args.repo)
    ledger_path = Path(args.ledger) if args.ledger else repo / ".canary" / "quarantine.json"

    try:
        diff, base = _load_diff(repo, args.diff_file)
    except FileNotFoundError as exc:
        print(f"{_PREFIX} {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - surface git failures loudly
        print(f"{_PREFIX} could not read diff: {exc}", file=sys.stderr)
        return 1

    deletions = diffscan.find_deletions(diff)
    entries = _to_entries(repo, base, deletions)

    if not args.no_write:
        try:
            ledger.append_entries(ledger_path, entries)
        except ValueError as exc:
            print(f"{_PREFIX} {exc}", file=sys.stderr)
            return 1

    areas = alarm.load_critical_areas(args.critical_areas)
    degraded = not areas.available
    findings = alarm.build_findings(deletions, areas, repo)

    if args.json:
        payload = {
            "schema_version": ledger.SCHEMA_VERSION,
            "captured": [d.to_dict() for d in deletions],
            "findings": [f.to_dict() for f in findings],
            "ledger": str(ledger_path),
        }
        if degraded:
            payload["degraded_notice"] = alarm.DEGRADED_NOTICE
        print(json.dumps(payload, indent=2))
    else:
        print(_render_text(deletions, findings, degraded))

    return 1 if (args.strict and findings) else 0


if __name__ == "__main__":
    sys.exit(main())
