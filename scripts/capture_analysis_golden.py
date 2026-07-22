#!/usr/bin/env python3
"""Capture Python analysis reports as golden fixtures for the TS parity test.

Reads the shared fixture ts/test/fixtures/history-v2.jsonl through the Python
AnalysisEngine and writes each artifact — normalized (ANSI stripped, per-line
trailing whitespace trimmed) — to ts/test/fixtures/golden/<name>.txt.

The TS parity test (ts/test/parity.test.ts) runs the ported engine over the
same fixture, normalizes identically, and asserts byte-for-byte equality. Run
this whenever the Python analysis output legitimately changes:

    .venv/bin/python scripts/capture_analysis_golden.py
"""

from __future__ import annotations

import re
from pathlib import Path

from agent.analysis.engine import AnalysisEngine
from agent.history.local_store import LocalHistoryStore

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_REPO = Path(__file__).resolve().parents[1]
_FIXTURE = _REPO / "ts" / "test" / "fixtures" / "history-v2.jsonl"
_GOLDEN = _REPO / "ts" / "test" / "fixtures" / "golden"


def normalize(text: str) -> str:
    """Strip ANSI escapes and per-line trailing whitespace (parity-safe)."""
    stripped = _ANSI.sub("", text)
    return "\n".join(line.rstrip() for line in stripped.split("\n"))


def main() -> int:
    store = LocalHistoryStore(_FIXTURE)
    result = AnalysisEngine(store=store).run()

    _GOLDEN.mkdir(parents=True, exist_ok=True)
    for artifact_name, content in sorted(result.artifacts.items()):
        # flaky.md -> flaky.txt
        out_name = artifact_name.rsplit(".", 1)[0] + ".txt"
        (_GOLDEN / out_name).write_text(normalize(content) + "\n", encoding="utf-8")
        print(f"wrote {out_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
