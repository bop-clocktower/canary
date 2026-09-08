#!/bin/bash
# Weekly deep canary siren.
#
# Does what the fast SessionStart siren cannot: network checks. Findings fire a
# desktop notification and are appended to the log, so rot gets announced even
# if no Claude session is opened all week.
#
# Scheduled by hooks/io.github.bop-clocktower.canary-deep-siren.plist. Install
# and verify both with:
#
#     node scripts/install-siren.mjs --install
#
# #758: this script documented its own launchd label in a header comment and
# nothing ever created the agent, so every check below was dark from the day it
# was written. The missing log was the tell — `note` is called unconditionally
# on the healthy path, so an absent log file means zero runs, not zero
# findings. There is no "it ran and was clean" reading of silence here.
set -u

LOG="${CANARY_SIREN_LOG:-$HOME/.claude/logs/canary-deep-siren.log}"
mkdir -p "$(dirname "$LOG")"
MKT="${CANARY_MARKETPLACE_DIR:-$HOME/.claude/plugins/marketplaces/bop-clocktower}"

# Optional local config. Absent is fine; see the doctor check below for why an
# absent config abstains rather than passing.
#
#     {"doctorRepos": ["~/projects/some-consumer"]}
#
# Deliberately not hardcoded: this repo is public, and a consumer checkout path
# names the consumer. Configure it per machine, never in the tree.
CONFIG="${CANARY_SIREN_CONFIG:-$HOME/.claude/canary-siren.json}"

FINDINGS=()

note() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# 1. Marketplace checkout vs upstream (the 7-week failure: stale checkout).
if [ -d "$MKT/.git" ]; then
  if git -C "$MKT" fetch origin --quiet 2>>"$LOG"; then
    BEHIND=$(git -C "$MKT" rev-list --count HEAD..origin/HEAD 2>/dev/null || echo "?")
    [ "$BEHIND" != "0" ] && FINDINGS+=("marketplace checkout is $BEHIND commit(s) behind upstream canary — run: claude plugin marketplace update bop-clocktower")
  else
    FINDINGS+=("could not fetch canary upstream — cannot verify freshness (cannot-verify is a finding, not a skip)")
  fi
else
  FINDINGS+=("bop-clocktower marketplace checkout missing at $MKT")
fi

# 2. Installed CLI vs npm latest.
CLI_VER=$(canary -V 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
NPM_VER=$(npm view canary-test-cli version 2>>"$LOG")
if [ -z "${CLI_VER:-}" ]; then
  FINDINGS+=("canary CLI missing or not reporting a version")
elif [ -n "${NPM_VER:-}" ] && [ "$CLI_VER" != "$NPM_VER" ]; then
  FINDINGS+=("canary CLI $CLI_VER behind npm latest $NPM_VER — run: canary upgrade")
elif [ -z "${NPM_VER:-}" ]; then
  FINDINGS+=("could not read npm latest for canary-test-cli — cannot verify CLI freshness")
fi

# 3. `canary doctor` in each configured consumer checkout. Any ✗ OR any skipped
#    check is a finding — "All checks passed" with skips is exactly the silence
#    this siren hunts (#505).
#
#    An unconfigured or unreadable list ABSTAINS loudly instead of passing. The
#    original version of this check silently did nothing when its one hardcoded
#    path was absent, which is a zero-denominator green: no complaint, nothing
#    behind it, indistinguishable from a clean run.
DOCTOR_REPOS=()
if [ -f "$CONFIG" ]; then
  while IFS= read -r repo; do
    [ -n "$repo" ] && DOCTOR_REPOS+=("${repo/#\~/$HOME}")
  done < <(python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for r in d.get('doctorRepos') or []:
    print(r)
" "$CONFIG" 2>/dev/null)
fi

if [ "${#DOCTOR_REPOS[@]}" -eq 0 ]; then
  FINDINGS+=("no doctorRepos configured in $CONFIG — the doctor probe verified nothing (a check with no targets is an abstention, not a pass)")
else
  for REPO in "${DOCTOR_REPOS[@]}"; do
    NAME=$(basename "$REPO")
    if [ ! -d "$REPO" ]; then
      FINDINGS+=("configured doctorRepo $NAME does not exist — cannot verify")
      continue
    fi
    DOCTOR=$(cd "$REPO" && canary doctor 2>&1)
    echo "$DOCTOR" | grep -q '✗' && FINDINGS+=("canary doctor reports failures in $NAME (see log)")
    SKIPPED=$(echo "$DOCTOR" | grep -c 'skipped' || true)
    [ "${SKIPPED:-0}" -gt 0 ] && FINDINGS+=("canary doctor skipped $SKIPPED check(s) in $NAME — a skipped check verified nothing")
    echo "$DOCTOR" >>"$LOG"
  done
fi

if [ "${#FINDINGS[@]}" -eq 0 ]; then
  note "OK — marketplace current, CLI ${CLI_VER:-?} == npm latest, doctor clean"
  exit 0
fi

note "SIREN — ${#FINDINGS[@]} finding(s):"
for f in "${FINDINGS[@]}"; do note "  - $f"; done

SUMMARY=$(printf '%s; ' "${FINDINGS[@]}")
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${SUMMARY:0:230}\" with title \"🚨 Canary deep siren: ${#FINDINGS[@]} finding(s)\" sound name \"Sosumi\"" 2>>"$LOG"
fi
exit 0
