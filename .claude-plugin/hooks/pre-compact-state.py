#!/usr/bin/env python3
# pre-compact-state.py — PreCompact:* hook
# Saves a brief session summary before context compaction.
# Writes to .harness/state/pre-compact-summary.json.
# Fail-open: always exits 0.

import json
import os
import sys
from datetime import datetime, timezone


def read_json_safe(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def find_active_session(sessions_dir):
    try:
        latest = None
        latest_mtime = 0.0
        for entry in os.scandir(sessions_dir):
            if not entry.is_dir():
                continue
            state_path = os.path.join(entry.path, "autopilot-state.json")
            try:
                mtime = os.stat(state_path).st_mtime
                if mtime > latest_mtime:
                    latest_mtime = mtime
                    latest = {"dir": entry.name, "state": read_json_safe(state_path)}
            except FileNotFoundError:
                pass
        return latest
    except Exception:
        return None


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        sys.exit(0)

    if not raw.strip():
        sys.stderr.write("[pre-compact-state] Empty stdin — allowing (fail-open)\n")
        sys.exit(0)

    try:
        json.loads(raw)
    except json.JSONDecodeError:
        sys.stderr.write("[pre-compact-state] Could not parse stdin — allowing (fail-open)\n")
        sys.exit(0)

    try:
        cwd = os.getcwd()
        harness_dir = os.path.join(cwd, ".harness")
        state_dir = os.path.join(harness_dir, "state")
        os.makedirs(state_dir, exist_ok=True)

        state = read_json_safe(os.path.join(harness_dir, "state.json")) or {}
        session = find_active_session(os.path.join(harness_dir, "sessions"))

        summary = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sessionId": session["dir"] if session else None,
            "activeStream": ((session["state"] or {}).get("currentState")) if session else None,
            "recentDecisions": state.get("decisions", [])[-5:],
            "openQuestions": state.get("blockers", []),
            "currentPhase": (state.get("position") or {}).get("phase"),
        }

        out_path = os.path.join(state_dir, "pre-compact-summary.json")
        with open(out_path, "w") as f:
            json.dump(summary, f, indent=2)
            f.write("\n")

        sys.stderr.write("[pre-compact-state] Saved pre-compact summary\n")
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"[pre-compact-state] Failed: {e}\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
