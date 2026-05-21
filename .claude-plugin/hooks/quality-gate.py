#!/usr/bin/env python3
# quality-gate.py — PostToolUse:Edit/Write hook
# Runs ruff check after Python file edits and warns on violations.
# Never blocks (always exits 0). Warnings go to stderr.

import json
import subprocess
import sys


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        sys.exit(0)

    if not raw.strip():
        sys.exit(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(0)

    try:
        file_path = data.get("tool_input", {}).get("file_path", "")

        if not isinstance(file_path, str) or not file_path:
            sys.exit(0)

        if not file_path.endswith(".py"):
            sys.exit(0)

        result = subprocess.run(
            ["ruff", "check", file_path],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            sys.stderr.write(f"[quality-gate] ruff found issues:\n{result.stdout[:500]}\n")
        else:
            sys.stderr.write("[quality-gate] ruff check passed\n")

        sys.exit(0)
    except FileNotFoundError:
        sys.exit(0)
    except Exception:
        sys.exit(0)


if __name__ == "__main__":
    main()
