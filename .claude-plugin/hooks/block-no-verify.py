#!/usr/bin/env python3
# block-no-verify.py — PreToolUse:Bash hook
# Blocks git commands that use --no-verify to skip hooks.
# Exit codes: 0 = allow, 2 = block

import json
import re
import sys


def strip_strings_and_comments(cmd):
    cmd = re.sub(r"<<-?\s*['\"]?(\w+)['\"]?[\s\S]*?\n\s*\1\b", " ", cmd)
    cmd = re.sub(r"'[^']*'", " ", cmd)
    cmd = re.sub(r'"(?:[^"\\]|\\.)*"', " ", cmd)
    cmd = re.sub(r"(^|[\s;&|`(])#[^\n]*", r"\1", cmd)
    return cmd


def contains_hook_bypass(command):
    stripped = strip_strings_and_comments(command)
    if re.search(r"(?:^|\s)--no-verify(?=\s|$)", stripped):
        return True
    if re.search(r"\bgit\s+(?:[\w-]+\s+)*?commit\b[^\n]*?(?:^|\s)-n(?=\s|$)", stripped):
        return True
    return False


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
        command = data.get("tool_input", {}).get("command", "")
        if not isinstance(command, str):
            sys.exit(0)

        if contains_hook_bypass(command):
            sys.stderr.write(
                "BLOCKED: --no-verify flag detected. Hooks must not be bypassed.\n"
            )
            sys.exit(2)

        sys.exit(0)
    except Exception:
        sys.exit(0)


if __name__ == "__main__":
    main()
