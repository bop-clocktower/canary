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

# Absolute path to this script. The generated fix script re-runs the siren to
# verify the end state, and it is opened from Terminal's own cwd (the home
# directory), so a relative $BASH_SOURCE would not resolve there.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

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
# Shell commands that would actually fix a finding, collected as findings are
# raised. Not every finding has one — a missing config or a failing `canary
# doctor` needs a human — so this stays a SUBSET of FINDINGS, and the click
# action says so rather than implying it fixed everything.
REMEDIES=()
FIX="${CANARY_SIREN_FIX:-$HOME/.claude/logs/canary-deep-siren.fix.sh}"

note() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# 1. Marketplace checkout vs upstream (the 7-week failure: stale checkout).
if [ -d "$MKT/.git" ]; then
  if git -C "$MKT" fetch origin --quiet 2>>"$LOG"; then
    BEHIND=$(git -C "$MKT" rev-list --count HEAD..origin/HEAD 2>/dev/null || echo "?")
    if [ "$BEHIND" != "0" ]; then
      FINDINGS+=("marketplace checkout is $BEHIND commit(s) behind upstream canary")
      REMEDIES+=("claude plugin marketplace update bop-clocktower")
    fi
  else
    FINDINGS+=("could not fetch canary upstream — cannot verify freshness (cannot-verify is a finding, not a skip)")
  fi
else
  FINDINGS+=("bop-clocktower marketplace checkout missing at $MKT")
fi

# 1b. Installed plugin vs marketplace checkout — the OTHER half of the update.
#     `claude plugin marketplace update` refreshes the checkout and returns ✔ while
#     leaving the installed plugin untouched, because the install is keyed on the
#     manifest's declared VERSION and upstream ships content under an unchanged one.
#     Checking only §1 therefore goes green on a half-applied update: that is the
#     2026-08-02 skew, re-reproduced 2026-09-08 (marketplace e923921→29ad0f2, install
#     pinned at e923921, 5 SKILL.md files stale). Compare the recorded install sha to
#     the checkout HEAD, and treat an unreadable manifest as a finding, not a skip.
INSTALLED_JSON="$HOME/.claude/plugins/installed_plugins.json"
if [ -d "$MKT/.git" ] && [ -f "$INSTALLED_JSON" ]; then
  MKT_HEAD=$(git -C "$MKT" rev-parse HEAD 2>/dev/null || echo "")
  INST_SHA=$(python3 -c "
import json,sys
try:
    e=json.load(open('$INSTALLED_JSON'))['plugins']['canary@bop-clocktower'][0]
except Exception:
    sys.exit(3)
print(e.get('gitCommitSha',''))
" 2>/dev/null)
  RC=$?
  if [ "$RC" -eq 3 ]; then
    FINDINGS+=("canary@bop-clocktower absent from installed_plugins.json — the plugin is not installed, or the manifest moved (cannot-verify is a finding)")
  elif [ -z "$INST_SHA" ]; then
    FINDINGS+=("installed canary plugin records no gitCommitSha — cannot prove it matches the marketplace checkout, so this run verified nothing about the install")
  elif [ -n "$MKT_HEAD" ] && [ "$INST_SHA" != "$MKT_HEAD" ]; then
    FINDINGS+=("installed canary plugin is at ${INST_SHA:0:7} but the marketplace checkout is at ${MKT_HEAD:0:7} — a marketplace update applied to only one half")
    REMEDIES+=("claude plugin uninstall canary@bop-clocktower && claude plugin install canary@bop-clocktower -y")
  fi
elif [ ! -f "$INSTALLED_JSON" ]; then
  FINDINGS+=("no installed_plugins.json at $INSTALLED_JSON — plugin install state unverifiable")
fi

# 2. Installed CLI vs npm latest.
CLI_VER=$(canary -V 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
NPM_VER=$(npm view canary-test-cli version 2>>"$LOG")
if [ -z "${CLI_VER:-}" ]; then
  FINDINGS+=("canary CLI missing or not reporting a version")
elif [ -n "${NPM_VER:-}" ] && [ "$CLI_VER" != "$NPM_VER" ]; then
  FINDINGS+=("canary CLI $CLI_VER behind npm latest $NPM_VER")
  REMEDIES+=("npm install -g canary-test-cli@latest")
elif [ -z "${NPM_VER:-}" ]; then
  FINDINGS+=("could not read npm latest for canary-test-cli — cannot verify CLI freshness")
fi

# 3. `canary doctor` in each configured consumer checkout. Any ✗, any skipped
#    check, OR an abstaining run is a finding — "All checks passed" with skips
#    is exactly the silence this siren hunts (#505), and an abstention is that
#    same silence with the denominator already at zero.
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
    # Capture the EXIT CODE, not just the text. Verified against the shipped
    # implementation (canary-test-cli 7.1.0 — dist/doctor.js summarizeChecks,
    # dist/gate-result.js gateOutcome/EXIT_ABSTAINED): doctor's denominator is
    # `checked = passed + failed`, so informational and skipped results are
    # EXCLUDED from it. When that denominator collapses to zero it returns
    # EXIT_ABSTAINED (3) and the line "Abstained — verified zero items; this is
    # not a pass" — which carries NO '✗' and, when nothing was formally skipped,
    # no "skipped" either. Both greps below therefore miss it, and a doctor run
    # that verified nothing renders as "doctor clean": the zero-denominator false
    # green this siren exists to catch, occurring inside the siren.
    DOCTOR=$(cd "$REPO" && canary doctor 2>&1)
    DOCTOR_RC=$?
    echo "$DOCTOR" | grep -q '✗' && FINDINGS+=("canary doctor reports failures in $NAME (see log)")
    SKIPPED=$(echo "$DOCTOR" | grep -c 'skipped' || true)
    [ "${SKIPPED:-0}" -gt 0 ] && FINDINGS+=("canary doctor skipped $SKIPPED check(s) in $NAME — a skipped check verified nothing")
    # Exit code first: it is the contract. The text match is belt-and-braces for
    # a future version that abstains without using that exit code.
    if [ "$DOCTOR_RC" -eq 3 ] || echo "$DOCTOR" | grep -q 'Abstained'; then
      FINDINGS+=("canary doctor ABSTAINED in $NAME (exit $DOCTOR_RC) — every check was skipped or informational, so it verified zero items. This is not a pass.")
    fi
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
TITLE="🚨 Canary deep siren: ${#FINDINGS[@]} finding(s)"

# Clicking the notification must DO the fix, not describe it.
#
# A banner that only opens a log leaves the actual work exactly where it was,
# and a weekly reminder you have to act on by hand is one you learn to swipe
# away — the same end state as not firing at all.
#
# So each finding that has a known remedy contributes its command to a
# generated fix script, and the click runs it in a visible Terminal window.
# Visible, not silent: these commands reinstall plugins and upgrade a global
# npm package, and a notification click is a low-confirmation gesture. The
# operator sees what runs and can close the window.
#
# AppleScript's `display notification` has NO click handler — there is no flag
# for it — so a real action requires terminal-notifier's `-execute`.
EXEC=""
if [ "${#REMEDIES[@]}" -gt 0 ]; then
  {
    echo "#!/bin/bash"
    echo "# Generated by canary-deep-siren on $(date '+%Y-%m-%d %H:%M:%S'). Regenerated every run."
    echo "# Fixes ${#REMEDIES[@]} of ${#FINDINGS[@]} finding(s); the rest need a human."
    echo "set -u"
    echo "echo '── canary deep siren: applying ${#REMEDIES[@]} fix(es) ──'"
    for r in "${REMEDIES[@]}"; do
      printf 'echo\necho "$ %s"\n%s\n' "$r" "$r"
    done
    # Re-run the siren rather than trusting the commands' own exit codes. The
    # 2026-08-02 skew is precisely a fix reporting success while leaving the
    # end state broken, so the fix script verifies the END STATE.
    echo 'echo'
    echo "echo '── re-running the siren to verify the end state ──'"
    printf '%s\n' "bash '$SELF'"
    echo "echo"
    echo "echo 'Findings after the fix:'"
    printf '%s\n' "tail -n 20 '$LOG'"
    echo 'echo; echo "Press return to close."; read -r _'
  } >"$FIX"
  chmod +x "$FIX"
  EXEC="/usr/bin/open -a Terminal '$FIX'"
  note "  fix script written to $FIX (${#REMEDIES[@]} of ${#FINDINGS[@]} finding(s) auto-fixable)"
else
  # Nothing is auto-fixable, so the honest action is to show the detail.
  EXEC="/usr/bin/open -t '$LOG'"
  note "  no auto-fixable finding — click opens the log"
fi

notified=0
if command -v terminal-notifier >/dev/null 2>&1; then
  # Not just "is it installed". terminal-notifier needs macOS notification
  # permission, which is a manual grant in System Settings and cannot be
  # scripted; without it the command FAILS and no banner appears at all —
  # strictly worse than the unclickable osascript one. So the fallback is
  # driven by the outcome, not by which binaries exist.
  TN_ERR=$(
    terminal-notifier \
      -title "$TITLE" \
      -message "${SUMMARY:0:230}" \
      -sound Sosumi \
      -execute "$EXEC" \
      -group canary-deep-siren 2>&1
  ) && [ -z "$TN_ERR" ] && notified=1
  if [ "$notified" -eq 1 ]; then
    note "  (banner posted; click runs: $EXEC)"
  else
    note "  terminal-notifier could not post: ${TN_ERR:-unknown error}"
    note "  → grant it notification permission in System Settings ▸ Notifications ▸ terminal-notifier, or the weekly banner stays unclickable"
  fi
fi

if [ "$notified" -eq 0 ] && command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${SUMMARY:0:230}\" with title \"$TITLE\" sound name \"Sosumi\"" 2>>"$LOG" && notified=1
  note "  (fell back to an UNCLICKABLE banner — osascript notifications support no click action)"
  [ "${#REMEDIES[@]}" -gt 0 ] && note "  → run the fixes by hand: bash $FIX"
fi

[ "$notified" -eq 0 ] && note "  (no notifier could post — findings are in this log only)"
exit 0
