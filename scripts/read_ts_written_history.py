#!/usr/bin/env python3
"""Cross-language write-seam verifier for the TS history port.

Two modes:

  read_ts_written_history.py golden [OUT]
      Emit the Python `asdict`-based serialization of a fixed RunRecord + one
      TestResult (the local NDJSON line shape) as pretty JSON. Written to OUT
      (default: ts/test/fixtures/history-write-golden.json). The TS
      `write-seam.test.ts` asserts its `serializeLocalRecord` produces the same
      object — a CI-safe write-format parity check (no Python at test time).

  read_ts_written_history.py read <PATH>
      Read a history-v2.jsonl file (typically one written by the TS `pushRun`)
      through the Python `LocalHistoryStore` and print `query_flaky` as JSON.
      Proves the reverse direction of the seam: Python reads what TS wrote.
      Run locally (not in the node-only CI job).
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from agent.history.local_store import LocalHistoryStore  # noqa: E402
from agent.history.schema import RunRecord, TestResult  # noqa: E402

_DEFAULT_GOLDEN = _REPO_ROOT / "ts" / "test" / "fixtures" / "history-write-golden.json"

# Fixed input — MUST stay in sync with the input in ts/test/write-seam.test.ts.
_RUN = RunRecord(
    run_id="api-abc12345-1700000000",
    suite="api",
    repo="acme/app",
    branch="main",
    commit_sha="abc12345def",
    timestamp="2026-06-01T00:00:00Z",
    total=10,
    passed=8,
    failed=1,
    flaky=1,
    skipped=0,
)
_RESULTS = [
    TestResult(
        run_id="api-abc12345-1700000000",
        suite="api",
        repo="acme/app",
        test_name="test_login",
        test_file="tests/test_login.py",
        status="flaky",
    )
]


def _local_record() -> dict:
    record = asdict(_RUN)
    record["tests"] = [asdict(t) for t in _RESULTS]
    return record


def _emit_golden(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(_local_record(), indent=2) + "\n", encoding="utf-8")
    print(f"wrote golden → {out}")


def _read(path: Path) -> None:
    store = LocalHistoryStore(path)
    print(json.dumps(store.query_flaky(window=30, suite=None, min_rate=0.0), indent=2))


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"golden", "read"}:
        print(__doc__)
        return 2
    if argv[0] == "golden":
        _emit_golden(Path(argv[1]) if len(argv) > 1 else _DEFAULT_GOLDEN)
        return 0
    if len(argv) < 2:
        print("read mode requires a PATH", file=sys.stderr)
        return 2
    _read(Path(argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
