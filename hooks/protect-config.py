#!/usr/bin/env python3
# protect-config.py — PreToolUse:Write/Edit hook
# Blocks modifications to Python project config files.
# Fail-open: parse errors and unexpected exceptions log to stderr and exit 0.
# Exit codes: 0 = allow, 2 = block

import json
import os
import re
import sys

from _harness_dedup import harness_hook_present

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

# Patterns harness's protect-config.js already guards. When that hook is wired
# we cede these to it and enforce only the Python-unique configs below, so
# ruff.toml edits aren't double-blocked (see #309). Everything not listed here
# (pyproject.toml, setup.cfg, setup.py, .flake8, mypy.ini, tox.ini) is
# Python-specific and has no harness counterpart — canary keeps protecting it.
_HARNESS_COVERED_PATTERNS = {
    r"^\.ruff\.toml$",
    r"^ruff\.toml$",
}


def _effective_patterns():
    if harness_hook_present("protect-config.js"):
        return [p for p in PROTECTED_PATTERNS if p not in _HARNESS_COVERED_PATTERNS]
    return PROTECTED_PATTERNS


def is_protected(file_path, patterns=None):
    base = os.path.basename(file_path)
    patterns = PROTECTED_PATTERNS if patterns is None else patterns
    return any(re.match(p, base) for p in patterns)


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

        if is_protected(file_path, _effective_patterns()):
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
