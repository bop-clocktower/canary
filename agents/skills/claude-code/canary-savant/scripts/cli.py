#!/usr/bin/env python3
"""canary-savant -- order-dependence and isolation detector (Tier-1 static scan).

Phase 1 ships the always-on static "suspect" tier: an AST-lite scan that flags
the shared-state smells that predict order-dependent tests -- module-level
mutables written by tests, setup without teardown, mutated process singletons,
order-coupled names -- with no test execution. The opt-in dynamic confirmer
(shuffle + run-alone + polluter bisect) lands in a later phase.

  <paths>    files or directories to scan (default: the current directory).
  --json     emit machine-readable findings instead of human text.
  --strict   exit 1 when there are findings (default is advisory: exit 0).

Tier-0 in the real sense -- no LLM, no network, no secrets, no dependency on any
other skill.

Invoked via `canary skills run canary-savant -- [paths] [--json] [--strict]`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scanner import scan_paths  # noqa: E402

SCHEMA_VERSION = 1


def _summary(result) -> dict:
    by_severity: dict = {}
    for finding in result.findings:
        by_severity[finding.severity] = by_severity.get(finding.severity, 0) + 1
    return {
        "files_scanned": result.files_scanned,
        "findings": len(result.findings),
        "by_severity": by_severity,
    }


def _render_text(result) -> str:
    count = len(result.findings)
    files = result.files_scanned
    if not count:
        return (
            "No order-dependence suspects "
            f"({files} file{'s' if files != 1 else ''} scanned)."
        )
    lines = [
        f"{count} order-dependence suspect{'s' if count != 1 else ''} "
        f"in {files} file{'s' if files != 1 else ''}:",
        "",
    ]
    for finding in result.findings:
        lines.append(
            f"  {finding.file}:{finding.line}  [{finding.severity}] {finding.rule_id}"
        )
        lines.append(f"      {finding.snippet}")
        lines.append(f"      why: {finding.why}")
    lines.append("")
    lines.append(
        "Advisory by default. Re-run with --strict to fail the step on findings."
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-savant",
        description="Flag static shared-state smells that predict order-dependent tests.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        default=None,
        metavar="PATH",
        help="Files or directories to scan (default: current directory).",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON findings.")
    parser.add_argument(
        "--strict", action="store_true", help="Exit 1 when there are findings."
    )
    args = parser.parse_args(argv)

    paths = args.paths or ["."]
    for entry in paths:
        if not Path(entry).exists():
            print(f"canary-savant: path not found: {entry}", file=sys.stderr)
            return 1

    result = scan_paths(paths)

    if args.json:
        print(
            json.dumps(
                {
                    "schema_version": SCHEMA_VERSION,
                    "findings": [f.to_dict() for f in result.findings],
                    "summary": _summary(result),
                },
                indent=2,
            )
        )
    else:
        print(_render_text(result))

    return 1 if (args.strict and result.findings) else 0


if __name__ == "__main__":
    sys.exit(main())
