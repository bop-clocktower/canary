#!/usr/bin/env python3
"""canary-test-reporter — Playwright JSON → Markdown + JSON report.

  --results <path>        required: Playwright JSON results file
  --markdown-out <path>   write Markdown report to file (stdout if neither flag given)
  --json-out <path>       write JSON report to file

Exit code: 1 when any test failed, else 0.

Invoked via `canary skills run canary-test-reporter -- --results <json>`.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make sibling modules importable by bare name (parse / render / json_report).
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-test-reporter",
        description="Playwright JSON results → Markdown + JSON test report.",
    )
    parser.add_argument("--results", required=True, metavar="PATH",
                        help="Playwright JSON results file.")
    parser.add_argument("--markdown-out", default=None, metavar="PATH",
                        help="Write Markdown report to file (default: stdout).")
    parser.add_argument("--json-out", default=None, metavar="PATH",
                        help="Write JSON report to file.")
    args = parser.parse_args(argv)

    results_path = Path(args.results)
    if not results_path.exists():
        print(
            f"canary-test-reporter: results file not found: {results_path}",
            file=sys.stderr,
        )
        return 1

    from parse import parse_results
    from render import render_markdown
    from json_report import render_json

    try:
        data = parse_results(results_path)
    except (OSError, ValueError) as exc:
        print(f"canary-test-reporter: {exc}", file=sys.stderr)
        return 1

    markdown = render_markdown(data)

    if args.markdown_out:
        Path(args.markdown_out).write_text(markdown, encoding="utf-8")
    elif not args.json_out:
        print(markdown, end="")

    if args.json_out:
        Path(args.json_out).write_text(render_json(data), encoding="utf-8")

    return 1 if data.failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
