#!/usr/bin/env python3
"""Git pre-commit hook — fail if staged files contain proprietary identifiers.

Wraps scripts/check_removed_symbols.py so the same check that runs in CI
also blocks local commits. Only inspects files staged for this commit
(not the full working tree) so it's fast and targeted.

Install once:
    python3 hooks/check-proprietary.py --install

Then runs automatically on every `git commit`. Uninstall:
    rm .git/hooks/pre-commit
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECK_SCRIPT = REPO_ROOT / "scripts" / "check_removed_symbols.py"


def install() -> None:
    hook_path = REPO_ROOT / ".git" / "hooks" / "pre-commit"
    hook_path.write_text(
        f"#!/bin/sh\npython3 {Path(__file__).resolve()} run\n",
        encoding="utf-8",
    )
    hook_path.chmod(0o755)
    print(f"Installed pre-commit hook → {hook_path}")


def run() -> int:
    """Run the proprietary check against files staged for this commit."""
    # Get staged file paths.
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    staged = [p for p in result.stdout.splitlines() if p.strip()]
    if not staged:
        return 0

    # Run the full check — it reads git-tracked files, which includes staged
    # content after `git add`. This is the same script CI runs.
    result = subprocess.run(
        [sys.executable, str(CHECK_SCRIPT)],
        cwd=REPO_ROOT,
    )
    return result.returncode


if __name__ == "__main__":
    if "--install" in sys.argv:
        install()
        sys.exit(0)
    sys.exit(run())
