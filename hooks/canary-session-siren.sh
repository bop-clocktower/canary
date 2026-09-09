#!/bin/bash
# SessionStart siren: yell about canary tooling rot before any work starts.
#
# Local-only checks (<1s, no network). Silent when everything is healthy; on
# findings, injects a loud warning into session context AND shows the user a
# systemMessage. Born of the 2026-07 incident where canary ran silently broken
# for ~7 weeks while every surface reported green.
#
# Check 5 is the one that closes a loop: it asserts the WEEKLY DEEP SIREN is
# registered and has logged a run recently. Without it, the only monitor of the
# deep siren is the deep siren — which is how #758 happened: the agent was
# never scheduled, so every network-level check was dark from the day it was
# written, and nothing on the machine could say so.
set -u

CLAUDE_DIR="${CANARY_CLAUDE_DIR:-$HOME/.claude}"
MKT="${CANARY_MARKETPLACE_DIR:-$CLAUDE_DIR/plugins/marketplaces/bop-clocktower}"
DEEP_LOG="${CANARY_SIREN_LOG:-$CLAUDE_DIR/logs/canary-deep-siren.log}"
DEEP_LABEL="${CANARY_SIREN_LABEL:-io.github.bop-clocktower.canary-deep-siren}"
# Weekly schedule + a grace day. A gap longer than this means runs are being
# missed, not merely that today is not the run day.
DEEP_STALE_DAYS="${CANARY_SIREN_STALE_DAYS:-8}"

FINDINGS=()

# 1. Plugin must be installed AND enabled (the June failure: flat files
#    bypassed the plugin system entirely, so nothing tracked versions).
if ! grep -q '"canary@bop-clocktower"' "$CLAUDE_DIR/plugins/installed_plugins.json" 2>/dev/null; then
  FINDINGS+=("canary plugin NOT installed (claude plugin install canary@bop-clocktower)")
elif ! python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
sys.exit(0 if d.get('enabledPlugins',{}).get('canary@bop-clocktower') else 1)" "$CLAUDE_DIR/settings.json" 2>/dev/null; then
  FINDINGS+=("canary plugin installed but NOT enabled in settings.json")
fi

# 2. Legacy flat-file overlay must stay dead — it shadows the plugin and rots.
LEGACY=$(find "$CLAUDE_DIR/agents" "$CLAUDE_DIR/commands" -maxdepth 1 -name 'canary-*.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "${LEGACY:-0}" -gt 0 ]; then
  FINDINGS+=("$LEGACY legacy flat-file canary agent/command file(s) back in ~/.claude — they shadow the plugin and drift silently; remove them")
fi

# 3. Marketplace checkout freshness (>14 days without a fetch = drifting).
if [ -d "$MKT/.git" ]; then
  LAST_FETCH="$MKT/.git/FETCH_HEAD"
  [ -f "$LAST_FETCH" ] || LAST_FETCH="$MKT/.git/HEAD"
  if [ -n "$(find "$LAST_FETCH" -mtime +14 2>/dev/null)" ]; then
    FINDINGS+=("bop-clocktower marketplace checkout not refreshed in >14 days (claude plugin marketplace update bop-clocktower)")
  fi
else
  FINDINGS+=("bop-clocktower marketplace checkout missing at $MKT")
fi

# 4. CLI vs plugin version skew (the npm CLI and the plugin must move together).
PLUGIN_VER=$(python3 -c "
import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$MKT/.claude-plugin/plugin.json" 2>/dev/null || echo "unknown")
if command -v canary >/dev/null 2>&1; then
  # canary -V prints a decorated ANSI banner; strip codes and pull the semver.
  CLI_VER=$(canary -V 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  CLI_VER=${CLI_VER:-unknown}
  if [ "$PLUGIN_VER" = "unknown" ] && [ -d "$MKT/.git" ]; then
    # Check 3's absent-config case abstains loudly; this one used to abstain
    # SILENTLY, in the same file. A skew comparison that cannot run verified
    # nothing.
    FINDINGS+=("cannot read the plugin version from $MKT/.claude-plugin/plugin.json — CLI-vs-plugin skew unverifiable")
  elif [ "$CLI_VER" = "unknown" ]; then
    FINDINGS+=("canary CLI did not report a parseable version — skew unverifiable")
  elif [ "$PLUGIN_VER" != "unknown" ] && [ "$CLI_VER" != "$PLUGIN_VER" ]; then
    FINDINGS+=("version skew: canary CLI $CLI_VER vs plugin $PLUGIN_VER — sync them")
  fi
else
  FINDINGS+=("canary CLI not on PATH")
fi

# 5. The deep siren must be REGISTERED and RECENT (#758).
#
#    Two separate failures, because they look identical from here — both are
#    silence — and only one of them is fixed by loading the agent:
#      a) never scheduled: launchctl does not know the label at all;
#      b) scheduled but not running: registered, yet the log is stale or absent.
#
#    An absent log is treated as "never ran", not as "ran and was clean". The
#    deep siren's healthy path calls `note` unconditionally, so silence there
#    has exactly one reading.
if ! command -v launchctl >/dev/null 2>&1; then
  # Checks 1-4 are portable, so this script does run where launchctl does not.
  # Silently skipping the scheduling check there is the pattern this whole
  # file indicts.
  FINDINGS+=("launchctl unavailable — deep-siren scheduling cannot be verified on this platform")
elif ! LAUNCHCTL_OUT=$(launchctl list 2>/dev/null); then
  # `launchctl list` fails outright in a non-Aqua session (e.g. over SSH).
  # Empty output would otherwise read as "not registered" and fire a FALSE
  # finding on every session start.
  FINDINGS+=("launchctl list failed (no GUI session?) — deep-siren registration unverifiable")
else
  if ! printf '%s' "$LAUNCHCTL_OUT" | grep -q "$DEEP_LABEL"; then
    FINDINGS+=("deep siren NOT registered with launchd ($DEEP_LABEL) — every network-level canary check is dark; run: node scripts/install-siren.mjs --install")
  elif [ ! -f "$DEEP_LOG" ]; then
    FINDINGS+=("deep siren is registered but has NEVER logged a run — an absent log means zero executions, not zero findings")
  elif [ -n "$(find "$DEEP_LOG" -mtime +"$DEEP_STALE_DAYS" 2>/dev/null)" ]; then
    FINDINGS+=("deep siren last logged a run >${DEEP_STALE_DAYS}d ago — it is registered but not firing")
  fi
fi

# Healthy: stay silent. Findings: yell into both the UI and model context.
if [ "${#FINDINGS[@]}" -eq 0 ]; then
  exit 0
fi

# The one place this hook can actually speak. If python3 is missing or the
# heredoc fails, every finding computed above is discarded and the hook exits
# 0 — which Claude Code reads as "healthy". A siren that cannot sound is worse
# than no siren, so the emit is checked and there is a plain-text fallback.
if ! python3 - "${FINDINGS[@]}" <<'EOF'
import json, sys
findings = sys.argv[1:]
lines = "\n".join(f"  - {f}" for f in findings)
msg = f"CANARY SIREN — {len(findings)} tooling-rot finding(s):\n{lines}"
print(json.dumps({
    "systemMessage": msg,
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": (
            "HEADLINE ALERT (canary session siren): the canary toolchain on this machine is degraded. "
            "Per the 'distrust green until vetted' rule, surface this to the user in your FIRST message "
            "and treat fixing it as outranking new work.\n" + msg
        ),
    },
}))
EOF
then
  # No JSON channel. Say it on stderr rather than vanishing.
  {
    echo "CANARY SIREN — ${#FINDINGS[@]} finding(s), and python3 was unavailable to"
    echo "emit them as hook JSON, so this session was NOT told:"
    for f in "${FINDINGS[@]}"; do echo "  - $f"; done
  } >&2
  exit 1
fi
exit 0
