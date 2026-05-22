#!/usr/bin/env python3
# protect-config.py — PreToolUse:Write/Edit hook
# Blocks modifications to Python project config files.
# Fail-open: parse errors and unexpected exceptions log to stderr and exit 0.
# Exit codes: 0 = allow, 2 = block

import json
import os
import re
import sys

PROTECTED_PATTERNS = [
    r"^pyproject\.toml$",
    r"^setup\.cfg$",
    r"^setup\.py$",
    r"^\.ruff\.toml$",
    r"^ruff\.toml$",
    r"^\.flake8$",
    r"^mypy\.ini$",
    r"^\.mypy\.ini$",
    r"^tox\.ini$",
]


def is_protected(file_path):
    base = os.path.basename(file_path)
    return any(re.match(p, base) for p in PROTECTED_PATTERNS)


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        sys.stderr.write("[protect-config] Could not read stdin — allowing (fail-open)\n")
        sys.exit(0)

    if not raw.strip():
        sys.stderr.write("[protect-config] Empty stdin — allowing (fail-open)\n")
        sys.exit(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.stderr.write("[protect-config] Could not parse stdin JSON — allowing (fail-open)\n")
        sys.exit(0)

    try:
        file_path = data.get("tool_input", {}).get("file_path", "")

        if not isinstance(file_path, str) or not file_path:
            sys.stderr.write("[protect-config] Missing file_path in tool input — allowing (fail-open)\n")
            sys.exit(0)

        if is_protected(file_path):
            sys.stderr.write(
                f"BLOCKED: Modification to protected config file: {os.path.basename(file_path)}. "
                "Project config files must not be weakened.\n"
            )
            sys.exit(2)

        sys.exit(0)
    except Exception:
        sys.stderr.write("[protect-config] Unexpected error — allowing (fail-open)\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
