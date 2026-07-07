#!/usr/bin/env python3
"""canary-fail-fast — surface test failures fast and loud.

Bundled CLI for the canary-fail-fast skill. Two halves:

  --config <playwright.config.*>  audit fail-fast knobs (maxFailures/forbidOnly/
                                  retries); print recommendations (read-only).
  --results <playwright.json>     print a loud, categorized failure digest to the
                                  CI log + ::error annotations; exit non-zero on
                                  any failure so the step fails.

At least one of --config / --results is required. Self-contained — no external
skill dependency.

Invoked via `canary skills run canary-fail-fast -- --results <json> [--config <path>]`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make the sibling modules importable by bare name (parse/digest/fastfail_check),
# exactly as they import each other.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-fail-fast",
        description="Fail-fast config audit + loud run-end failure digest.",
    )
    parser.add_argument("--results", default=None, metavar="PATH", help="Playwright JSON results.")
    parser.add_argument("--config", default=None, metavar="PATH", help="Playwright config file.")
    args = parser.parse_args(argv)

    if not args.results and not args.config:
        print(
            "canary-fail-fast: nothing to do — pass --results and/or --config.",
            file=sys.stderr,
        )
        return 1

    # ---- config audit -----------------------------------------------------
    if args.config:
        from fastfail_check import check_config

        try:
            text = Path(args.config).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"canary-fail-fast: cannot read config: {exc}", file=sys.stderr)
            return 1
        recs = check_config(text)
        if recs:
            print("Fail-fast config recommendations:")
            for r in recs:
                print(f"  - {r}")
        else:
            print("Fail-fast config OK.")

    # ---- failure digest ---------------------------------------------------
    exit_code = 0
    if args.results:
        results_path = Path(args.results)
        if not results_path.exists():
            print(
                f"canary-fail-fast: results file not found: {results_path}",
                file=sys.stderr,
            )
            return 1

        from parse import parse_failures
        from digest import build_digest

        try:
            failures = parse_failures(results_path)
        except ValueError as exc:
            print(f"canary-fail-fast: {exc}", file=sys.stderr)
            return 1

        d = build_digest(failures)
        print(d.text)
        for ann in d.annotations:
            print(ann)
        exit_code = d.exit_code

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
