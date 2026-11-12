#!/bin/bash
# SessionStart siren: yell about canary tooling rot before any work starts.
#
# Local checks plus ONE bounded network call (`git ls-remote`, capped at
# $CANARY_SIREN_LS_REMOTE_TIMEOUT seconds). Silent when everything is healthy; on
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
# Ceiling on the one network call (check 3). SessionStart latency is felt on
# every session, so an origin that never answers costs this, never more.
LS_REMOTE_TIMEOUT="${CANARY_SIREN_LS_REMOTE_TIMEOUT:-3}"

# Single-quote a value for a copy-pasteable remedy (bash 3.2 has no ${v@Q}).
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Set ORIGIN_TIP to origin's HEAD sha via `git ls-remote`, killed after
# LS_REMOTE_TIMEOUT seconds (macOS ships no `timeout`, so a watchdog does it).
# On failure returns 1 and sets LS_REMOTE_WHY. Called directly, not in $(...),
# so both globals survive. Never prompts for https credentials, and any other
# prompt (ssh) is cut off by the timeout rather than hanging the session.
ORIGIN_TIP="unknown"
LS_REMOTE_WHY=""
origin_tip() {
  local out pid wd rc tip fired=0
  out=$(mktemp "${TMPDIR:-/tmp}/canary-siren.XXXXXX") || {
    LS_REMOTE_WHY="could not create a temp file"
    return 1
  }
  # GIT_SSH_COMMAND is deliberately left alone: setting it would override a
  # user's core.sshCommand and turn a reachable origin into a false finding.
  GIT_TERMINAL_PROMPT=0 git -C "$MKT" ls-remote origin HEAD >"$out" 2>/dev/null </dev/null &
  pid=$!
  # The watchdog's stdio is detached so a lingering sleep cannot hold the
  # hook's stdout open after it exits. It drops a marker BEFORE the kill, so
  # by the time ls-remote dies of it the marker is already on disk (#1609).
  # `;` not `&&` after the marker: a marker that cannot be written must not
  # cost the timeout bound.
  (sleep "$LS_REMOTE_TIMEOUT" && { : >"$out.fired"; kill "$pid"; }) >/dev/null 2>&1 </dev/null &
  wd=$!
  wait "$pid" 2>/dev/null # no "Terminated" noise on stderr when killed
  rc=$?
  # Git's own exit codes overlap signal ones (128 is a plain failure), so the
  # marker, not rc, says whether the watchdog fired. Never infer it from the
  # watchdog being dead: wait can return while the subshell that just sent
  # the kill is still alive, which reported real timeouts as offline (#1609).
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null # reaped, so no marker can appear after the check
  [ -e "$out.fired" ] && fired=1
  tip=$(awk '$2 == "HEAD" { print $1; exit }' "$out")
  rm -f "$out" "$out.fired"
  if [ "$rc" -ne 0 ] && [ "$fired" = 1 ]; then
    LS_REMOTE_WHY="timed out after ${LS_REMOTE_TIMEOUT}s"
  elif [ "$rc" -ne 0 ]; then
    LS_REMOTE_WHY="failed (offline, or origin unreachable)"
  elif ! printf '%s' "$tip" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'; then
    LS_REMOTE_WHY="returned no HEAD"
  else
    ORIGIN_TIP=$tip
    return 0
  fi
  return 1
}

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

# 3. Marketplace clone freshness: the clone's HEAD against origin's HEAD as
#    origin reports it right now (#1599). This judged freshness by FETCH_HEAD's
#    mtime, and `claude plugin marketplace update` — the remedy it named —
#    does not write FETCH_HEAD, so the finding survived its own fix while
#    clone, origin and install all sat on the same commit. The end state is
#    the thing to check; when a fetch last happened is not. An origin that
#    cannot be asked is a loud abstention, never a pass.
if [ -d "$MKT/.git" ]; then
  if origin_tip; then
    MKT_HEAD=$(git -C "$MKT" rev-parse --verify -q HEAD 2>/dev/null || echo "unknown")
    if [ "$MKT_HEAD" != "$ORIGIN_TIP" ]; then
      FINDINGS+=("bop-clocktower marketplace clone is behind origin (clone @${MKT_HEAD:0:7}, origin @${ORIGIN_TIP:0:7}) — run: git -C $(shq "$MKT") pull --ff-only")
    fi
  else
    FINDINGS+=("git ls-remote origin HEAD $LS_REMOTE_WHY for $MKT — marketplace freshness and installed-plugin staleness unverifiable")
  fi
else
  FINDINGS+=("bop-clocktower marketplace checkout missing at $MKT")
fi

# 4. CLI vs plugin version skew (the npm CLI and the plugin must move together).
#    Compared against the INSTALLED plugin — the one Claude Code loads — not
#    the marketplace clone (#1491). The clone moves on `marketplace update`
#    while the install stays put, so reading the clone went quiet exactly when
#    the install was stale.
INSTALLED_JSON="$CLAUDE_DIR/plugins/installed_plugins.json"
PLUGIN_INSTALLED=0
grep -q '"canary@bop-clocktower"' "$INSTALLED_JSON" 2>/dev/null && PLUGIN_INSTALLED=1
read -r INST_VER INST_SHA <<<"$(python3 -c "
import json,sys
e=(json.load(open(sys.argv[1])).get('plugins',{}).get('canary@bop-clocktower') or [{}])[0]
print(e.get('version') or 'unknown', e.get('gitCommitSha') or 'unknown')" "$INSTALLED_JSON" 2>/dev/null || echo "unknown unknown")"
if [ "$PLUGIN_INSTALLED" = 1 ] && { [ "$INST_VER" = "unknown" ] || [ "$INST_SHA" = "unknown" ]; }; then
  # Check 1 already reports a missing install; this is an install whose record
  # cannot be read, which verifies nothing.
  FINDINGS+=("cannot read the installed canary plugin's version/commit from $INSTALLED_JSON — CLI-vs-plugin skew and staleness unverifiable")
fi
if command -v canary >/dev/null 2>&1; then
  # canary -V prints a decorated ANSI banner; strip codes and pull the semver.
  CLI_VER=$(canary -V 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  CLI_VER=${CLI_VER:-unknown}
  if [ "$CLI_VER" = "unknown" ]; then
    FINDINGS+=("canary CLI did not report a parseable version — skew unverifiable")
  elif [ "$INST_VER" != "unknown" ] && [ "$CLI_VER" != "$INST_VER" ]; then
    FINDINGS+=("version skew: canary CLI $CLI_VER vs installed plugin $INST_VER — sync them")
  fi
else
  FINDINGS+=("canary CLI not on PATH")
fi

# 4b. Installed plugin vs origin's tip. canary main often lands without a
#     plugin.json bump, and `claude plugin update` compares version strings
#     only, so equal versions can still mean stale files. The commit is the
#     only thing that tells.
#
#     The reference is origin's live HEAD from check 3, not any local ref
#     (#1495, #1599): a local ref is only as fresh as the last fetch, and how
#     fresh that is cannot be read reliably from disk. When check 3 could not
#     reach origin it has already reported this check as unverifiable.
if [ "$INST_SHA" != "unknown" ] && [ "$ORIGIN_TIP" != "unknown" ] &&
  [ "$ORIGIN_TIP" != "$INST_SHA" ]; then
  FINDINGS+=("installed canary plugin is behind the marketplace (installed $INST_VER @${INST_SHA:0:7}, origin @${ORIGIN_TIP:0:7}) — once the clone is at origin: claude plugin uninstall canary@bop-clocktower && claude plugin install canary@bop-clocktower --scope user")
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
