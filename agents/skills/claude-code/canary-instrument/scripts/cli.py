#!/usr/bin/env python3
"""canary-instrument — correlate a Playwright run's tests to their outbound HTTP spans.

Reads OTel span JSONL files written by otel_bootstrap/instrument.mjs (see
SKILL.md for the two manual wiring steps), resolves each Playwright test's
root span (set by otel_bootstrap/playwright-fixture.ts), attaches HTTP
child spans, and writes a run.json v1 artifact (trace-only; see
run_types.RunArtifact for the contract).

Invoked via:
  canary skills run canary-instrument -- \\
    --spans test-results/trace --output test-results [--suite-type e2e_ui]

Missing/empty --spans is not a failure — it produces an empty trace block.
Self-contained — no external skill dependency.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Make the sibling modules importable by bare name (run_types/span_reader),
# exactly as they import each other.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canary-instrument",
        description="Correlate a Playwright run's tests to their outbound HTTP spans.",
    )
    parser.add_argument("--spans", required=True, metavar="DIR",
                        help="Directory containing otel-spans.<worker>.jsonl files.")
    parser.add_argument("--output", required=True, metavar="DIR",
                        help="Directory to write run.json into (created if missing).")
    parser.add_argument("--suite-type", default="", metavar="STR",
                        help="Free-form suite label, passed through verbatim.")
    args = parser.parse_args(argv)

    spans_dir = Path(args.spans)
    if spans_dir.exists() and not spans_dir.is_dir():
        print(f"canary-instrument: --spans is not a directory: {spans_dir}", file=sys.stderr)
        return 1

    from run_types import RunArtifact
    from span_reader import read_traces

    trace = read_traces(spans_dir)
    artifact = RunArtifact(
        schema_version=1,
        suite_type=args.suite_type,
        generated_at=datetime.now(timezone.utc).isoformat(),
        trace=trace,
    )

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "run.json"
    out_path.write_text(json.dumps(artifact.to_dict(), indent=2), encoding="utf-8")

    print(
        f"canary-instrument: wrote {out_path} "
        f"({trace.spans_total} spans, {len(trace.by_test)} test buckets)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
