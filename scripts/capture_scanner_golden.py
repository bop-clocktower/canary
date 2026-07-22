#!/usr/bin/env python3
"""Capture Python golden output for the core/ scanners TS parity harness.

Runs MetadataScanner, DomainScanner, FixtureScanner, and StaticLinter over the
shared fixture project (ts/test/fixtures/scanner-project) and writes structured
JSON to ts/test/fixtures/scanner-golden/. The TS `scanner-parity.test.ts` runs
the ported scanners over the same tree and asserts equality.

Run from the repo root:  .venv/bin/python scripts/capture_scanner_golden.py
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROJECT = REPO_ROOT / "ts" / "test" / "fixtures" / "scanner-project"
GOLDEN = REPO_ROOT / "ts" / "test" / "fixtures" / "scanner-golden"

from agent.core.domain_scanner import DomainScanner  # noqa: E402
from agent.core.fixture_scanner import FixtureScanner  # noqa: E402
from agent.core.metadata_scanner import MetadataScanner  # noqa: E402
from agent.core.static_linter import StaticLinter  # noqa: E402


def _write(name: str, payload: object) -> None:
    GOLDEN.mkdir(parents=True, exist_ok=True)
    path = GOLDEN / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO_ROOT)}")


def main() -> None:
    # Scan a copy in a temp dir whose path has no ignored-dir segment. The
    # committed fixture lives under ts/test/fixtures/, and DomainScanner rejects
    # any file whose absolute path contains a "test"/"fixtures" segment — so
    # scanning it in place would find nothing. The TS parity test copies to a
    # temp dir the same way.
    tmp_root = Path(tempfile.mkdtemp(prefix="canary-scanner-")) / "project"
    shutil.copytree(PROJECT, tmp_root)
    os.chdir(tmp_root)

    md = MetadataScanner().scan(".")
    _write(
        "metadata",
        {
            "js_dependencies": md.js_dependencies,
            "python_packages": md.python_packages,
            "tsconfig": md.tsconfig,
            "detected_languages": sorted(md.detected_languages),
        },
    )

    domain = DomainScanner().scan(".")
    _write(
        "domain",
        {
            "source_files": domain.source_files,
            "modules": domain.modules,
            "components": domain.components,
            "functions": domain.functions,
            "api_routes": domain.api_routes,
        },
    )

    fixtures = FixtureScanner().scan(".")
    _write(
        "fixture",
        {"by_module": fixtures.by_module, "files_scanned": fixtures.files_scanned},
    )

    target = Path("tests/lint-target.spec.ts")
    linter = StaticLinter()
    _write("lint", [dataclasses.asdict(f) for f in linter.lint(target)])
    _write("flake", [dataclasses.asdict(f) for f in linter.flake_check(target)])


if __name__ == "__main__":
    main()
