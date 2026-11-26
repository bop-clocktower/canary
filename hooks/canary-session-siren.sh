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

# The reference every freshness check compares against is the LATEST RELEASE,
# not origin's HEAD (#1695). main takes several commits a day, so "one commit
# behind main" fired nearly every session and taught people to skim the siren.
# release.yml moves the floating `latest` tag to the highest stable vX.Y.Z, so
# a release is the thing worth an alert, and an install pinned to `#latest` is
# exactly one.
#
# Set ORIGIN_TIP to the commit `latest` points at, and RELEASE_VER to the
# vX.Y.Z tag on that same commit, via one `git ls-remote`, killed after
# LS_REMOTE_TIMEOUT seconds (macOS ships no `timeout`, so a watchdog does it).
# On failure returns 1 and sets LS_REMOTE_WHY. Called directly, not in $(...),
# so the globals survive. Never prompts for https credentials, and any other
# prompt (ssh) is cut off by the timeout rather than hanging the session.
ORIGIN_TIP="unknown"
RELEASE_VER="unknown"
LS_REMOTE_WHY=""
LS_REMOTE_WHAT="git ls-remote origin refs/tags/latest"
origin_tip() {
  local out pid wd rc tip fired=0
  out=$(mktemp "${TMPDIR:-/tmp}/canary-siren.XXXXXX") || {
    LS_REMOTE_WHY="could not create a temp file"
    return 1
  }
  # GIT_SSH_COMMAND is deliberately left alone: setting it would override a
  # user's core.sshCommand and turn a reachable origin into a false finding.
  GIT_TERMINAL_PROMPT=0 git -C "$MKT" ls-remote origin 'refs/tags/latest*' 'refs/tags/v*' >"$out" 2>/dev/null </dev/null &
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
  # An annotated tag lists its own object and then the commit as `<tag>^{}`;
  # the commit is the one to compare, so the peeled line wins when present.
  tip=$(awk '$2 == "refs/tags/latest^{}" { p = $1 } $2 == "refs/tags/latest" { t = $1 }
    END { print (p != "" ? p : t) }' "$out")
  if [ -n "$tip" ]; then
    # The stable vX.Y.Z on the same commit names the release. Same peel rule
    # per tag; a pre-release (vX.Y.Z-rc1) never names one, as `latest` skips them.
    RELEASE_VER=$(awk -v tip="$tip" '
      { ref = $2; peeled = sub(/\^\{\}$/, "", ref); sub(/^refs\/tags\/v/, "", ref) }
      ref ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ { if (peeled) p[ref] = $1; else if (!(ref in p)) p[ref] = $1 }
      END { for (v in p) if (p[v] == tip) { print v; exit } }' "$out")
    RELEASE_VER=${RELEASE_VER:-unknown}
  fi
  rm -f "$out" "$out.fired"
  if [ "$rc" -ne 0 ] && [ "$fired" = 1 ]; then
    LS_REMOTE_WHY="timed out after ${LS_REMOTE_TIMEOUT}s"
  elif [ "$rc" -ne 0 ]; then
    LS_REMOTE_WHY="failed (offline, or origin unreachable)"
  elif ! printf '%s' "$tip" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'; then
    LS_REMOTE_WHY="returned no latest release tag"
  else
    ORIGIN_TIP=$tip
    return 0
  fi
  return 1
}

# The release as people say it: "v9.7.0 @06c1504", or just the commit when no
# vX.Y.Z tag sits on it.
release_label() {
  if [ "$RELEASE_VER" != "unknown" ]; then
    printf 'v%s @%s' "$RELEASE_VER" "${ORIGIN_TIP:0:7}"
  else
    printf '@%s' "${ORIGIN_TIP:0:7}"
  fi
}

# The remedy that brings a behind clone to the release. A clone on a branch
# (one added without a ref, tracking main) fast-forwards with a pull. A clone
# on a detached HEAD (added with `#latest`) has nothing to pull into, so it
# gets Claude Code's own refresh, which re-resolves the ref.
clone_refresh() {
  if git -C "$MKT" symbolic-ref -q HEAD >/dev/null 2>&1; then
    printf 'git -C %s pull --ff-only' "$(shq "$MKT")"
  else
    printf 'claude plugin marketplace update bop-clocktower'
  fi
}

# 0 when $1 is X.Y.Z or X.Y.Z-suffix, the only shapes version_lt can rank.
is_semver() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$'; }

# 0 when version $1 is older than $2 (X.Y.Z, numeric per field); 1 otherwise,
# including when either cannot be read, so the caller checks is_semver first.
# On equal X.Y.Z a pre-release precedes its release (semver §11, #1710):
# 9.6.0-rc.1 < 9.6.0. Two pre-releases of one X.Y.Z are not ranked against
# each other; the release side is always a bare X.Y.Z tag, so that never arises.
version_lt() {
  local a1 a2 a3 b1 b2 b3
  is_semver "$1" && is_semver "$2" || return 1
  IFS=. read -r a1 a2 a3 <<<"${1%%-*}"
  IFS=. read -r b1 b2 b3 <<<"${2%%-*}"
  [ "$a1" -lt "$b1" ] && return 0
  [ "$a1" -gt "$b1" ] && return 1
  [ "$a2" -lt "$b2" ] && return 0
  [ "$a2" -gt "$b2" ] && return 1
  [ "$a3" -lt "$b3" ] && return 0
  [ "$a3" -gt "$b3" ] && return 1
  [ "$1" != "${1%%-*}" ] && [ "$2" = "${2%%-*}" ]
}

# How the clone's HEAD relates to ORIGIN_TIP (the latest release, #1695) once
# the two differ (#1682).
# Inequality is not ordering: only an ancestor is "behind", the one case
# `pull --ff-only` is guaranteed to clear. Prints one of:
#   behind    MKT_HEAD is an ancestor of origin's tip
#   unfetched origin's tip is not in the clone, so the clone cannot contain
#             it (behind, or diverged); a pull fetches it, then either
#             fast-forwards or refuses loudly, so it never no-ops
#   ahead     origin's tip is an ancestor of MKT_HEAD (a pull is a no-op)
#   diverged  neither is an ancestor of the other (a pull cannot ff)
#   unknown   the clone's HEAD could not be read
clone_relation() {
  if [ "$MKT_HEAD" = "unknown" ]; then
    echo unknown
  elif ! git -C "$MKT" cat-file -e "$ORIGIN_TIP^{commit}" 2>/dev/null; then
    echo unfetched
  elif git -C "$MKT" merge-base --is-ancestor "$MKT_HEAD" "$ORIGIN_TIP" 2>/dev/null; then
    echo behind
  elif git -C "$MKT" merge-base --is-ancestor "$ORIGIN_TIP" "$MKT_HEAD" 2>/dev/null; then
    echo ahead
  else
    echo diverged
  fi
}

# Healthy: stay silent. Findings: yell into both the UI and model context.
# Always exits, so check 0 can stop the hook before the later checks run.
emit_and_exit() {
  if [ "${#FINDINGS[@]}" -eq 0 ]; then
    exit 0
  fi

  # The one place this hook can actually speak. If python3 is missing or the
  # heredoc fails, every finding computed above is discarded and the hook
  # exits 0 — which Claude Code reads as "healthy". A siren that cannot sound
  # is worse than no siren, so the emit is checked and there is a plain-text
  # fallback.
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
}

FINDINGS=()

# 0. This hook against the marketplace's copy of itself (#1632).
#    install-siren.mjs installs hooks into ~/.claude/hooks/ as COPIES, and
#    neither `claude plugin marketplace update` nor a plugin reinstall touches
#    them. So a merged siren fix never reaches the machine until someone
#    reinstalls, and meanwhile the stale copy keeps firing findings from the
#    logic the fix replaced, with remedies that cannot clear them (#1599
#    outlived its own merge this way). The compare itself is a local byte
#    compare; only a differing copy goes on to ask origin (below).
#    When the copies differ, every check below may be other logic too, so
#    this finding REPLACES them rather than joining them.
#
#    A byte compare says the copies DIFFER, not which is newer (#1670). The
#    hooks may have come from a dev checkout ahead of a clone that is itself
#    behind the latest release (#1695), and then `--install-hooks` from that
#    clone would overwrite the newer copy with a stale one. So check 3's clone-freshness call runs
#    here too (same capped ls-remote, no extra call: the hook exits after),
#    and a behind clone is reported with "pull the clone first" in place of
#    the install remedy. Only a clone that is truly behind gets that (#1682):
#    an ahead clone contains the release and keeps the plain install remedy;
#    a diverged one cannot be cleared by a pull, so it keeps the install
#    remedy with a caveat. An origin that cannot be asked, or a clone
#    with no .git, keeps the install remedy and says freshness is unverifiable
#    rather than going quiet about it.
SELF="${BASH_SOURCE[0]:-}"
MKT_SELF="$MKT/hooks/$(basename "${SELF:-canary-session-siren.sh}")"
if [ -d "$MKT" ]; then # an absent clone is check 3's finding
  if [ -z "$SELF" ] || [ ! -r "$SELF" ] || [ ! -r "$MKT_SELF" ]; then
    FINDINGS+=("cannot compare this siren hook with the marketplace copy (${SELF:-unknown path} vs $MKT_SELF) — whether it is current is unverifiable")
  elif ! cmp -s "$SELF" "$MKT_SELF"; then
    DIFFERS="siren hook differs from the marketplace copy ($SELF vs $MKT_SELF), so its other checks may not match the marketplace's and were skipped"
    MKT_HEAD=$(git -C "$MKT" rev-parse --verify -q HEAD 2>/dev/null || echo "unknown")
    INSTALL="node $(shq "$MKT/scripts/install-siren.mjs") --install-hooks"
    # Three separate outcomes, never folded into one && chain: a clone that
    # cannot be checked is an abstention to state, not "heads equal" (#1682).
    if [ ! -d "$MKT/.git" ]; then
      FINDINGS=(
        "$DIFFERS — run: $INSTALL"
        "clone freshness unverifiable: $MKT has no .git, so whether its hooks match origin cannot be checked — install from it only if you know it is current"
      )
    elif ! origin_tip; then
      FINDINGS=(
        "$DIFFERS — run: $INSTALL"
        "clone freshness unverifiable: $LS_REMOTE_WHAT $LS_REMOTE_WHY for $MKT — install from it only if you know it is current"
      )
    elif [ "$MKT_HEAD" = "$ORIGIN_TIP" ]; then
      FINDINGS=("$DIFFERS — run: $INSTALL")
    else
      # Against the release (#1695): a clone that contains it (ahead, as a
      # clone tracking main is) is a safe source; only behind and diverged
      # are worth a caveat.
      REL=$(clone_relation)
      case "$REL" in
      behind | unfetched)
        FINDINGS=(
          "bop-clocktower marketplace clone is behind the latest release (clone @${MKT_HEAD:0:7}, release $(release_label)), so it is not a safe source for the siren hooks — pull the clone first, run: $(clone_refresh)"
          "$DIFFERS — once the clone has the release, the next session compares again"
        )
        ;;
      ahead)
        FINDINGS=("$DIFFERS — run: $INSTALL")
        ;;
      diverged)
        FINDINGS=(
          "bop-clocktower marketplace clone differs from the latest release (diverged) (clone @${MKT_HEAD:0:7}, release $(release_label)) — a pull cannot bring it to the release; inspect: git -C $(shq "$MKT") log --oneline ${ORIGIN_TIP:0:12}..HEAD"
          "$DIFFERS — the clone has commits the release does not have, so this installs them too; run: $INSTALL"
        )
        ;;
      *)
        FINDINGS=(
          "$DIFFERS — run: $INSTALL"
          "clone freshness unverifiable: $MKT has no readable HEAD to compare with the latest release $(release_label) — install from it only if you know it is current"
        )
        ;;
      esac
    fi
    emit_and_exit
  fi
fi

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
#
#    The reference is the latest release, not origin's HEAD (#1695): a clone
#    that contains the release is current, however far main has moved since.
if [ -d "$MKT/.git" ]; then
  if origin_tip; then
    MKT_HEAD=$(git -C "$MKT" rev-parse --verify -q HEAD 2>/dev/null || echo "unknown")
    # Inequality is not ordering (#1682): only a clone a pull can clear is
    # "behind"; a diverged one gets no remedy that no-ops. An ahead clone
    # contains the release, so it is current (#1695).
    if [ "$MKT_HEAD" != "$ORIGIN_TIP" ]; then
      REL=$(clone_relation)
      case "$REL" in
      behind | unfetched)
        FINDINGS+=("bop-clocktower marketplace clone is behind the latest release (clone @${MKT_HEAD:0:7}, release $(release_label)) — run: $(clone_refresh)")
        ;;
      ahead) ;;
      diverged)
        FINDINGS+=("bop-clocktower marketplace clone differs from the latest release (diverged) (clone @${MKT_HEAD:0:7}, release $(release_label)) — a pull cannot bring it to the release; inspect: git -C $(shq "$MKT") log --oneline ${ORIGIN_TIP:0:12}..HEAD")
        ;;
      *)
        FINDINGS+=("bop-clocktower marketplace clone has no readable HEAD to compare with the latest release $(release_label) — freshness unverifiable")
        ;;
      esac
    fi
  else
    FINDINGS+=("$LS_REMOTE_WHAT $LS_REMOTE_WHY for $MKT — marketplace freshness and installed-plugin staleness unverifiable")
  fi
elif [ -d "$MKT" ]; then
  # Present but not a clone (#1692): naming it missing points at the wrong fix.
  FINDINGS+=("bop-clocktower marketplace directory at $MKT is present but not a git clone — remove the stale directory or re-clone")
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

# 4b. Installed plugin vs the latest release (#1695). Commits on main between
#     releases are not rot: the alert is for a release this machine does not
#     run. Every release bumps plugin.json, so the installed version against
#     the release's vX.Y.Z tag is the whole comparison. (Comparing commits
#     against origin's HEAD fired on every merge to main.)
#
#     The release is read from origin live in check 3, not from any local ref
#     (#1495, #1599): a local ref is only as fresh as the last fetch. When
#     check 3 could not reach origin it has already reported this check as
#     unverifiable. A `latest` that sits on no vX.Y.Z tag cannot be ranked,
#     and that is said rather than passed.
if [ "$INST_VER" != "unknown" ] && [ "$ORIGIN_TIP" != "unknown" ]; then
  if [ "$RELEASE_VER" = "unknown" ]; then
    FINDINGS+=("the latest tag (@${ORIGIN_TIP:0:7}) sits on no vX.Y.Z release tag — whether installed canary $INST_VER is current is unverifiable")
  elif ! is_semver "$INST_VER"; then
    # version_lt reads an unparseable version as "not older"; say so instead.
    FINDINGS+=("installed canary plugin version $INST_VER is not X.Y.Z — whether it is older than the latest release v$RELEASE_VER is unverifiable")
  elif version_lt "$INST_VER" "$RELEASE_VER"; then
    FINDINGS+=("installed canary plugin $INST_VER is older than the latest release v$RELEASE_VER — once the clone has the release: claude plugin uninstall canary@bop-clocktower && claude plugin install canary@bop-clocktower --scope user")
  fi
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

# 6. This session's checkout commits through the tracked pre-commit (#1240).
#    AGENTS.md asks for a one-time `git config core.hooksPath .githooks`, and
#    nothing checked it. A clone that skipped it runs whatever copy sits in
#    .git/hooks/pre-commit, or no hook at all, and every worktree inherits that
#    through the common git dir. This hook is machine-global, so the repo is
#    the session's: CLAUDE_PROJECT_DIR, else the working directory.
#
#    Report only. The siren writes no git config: a hook that edits config at
#    session start would be a silent install step, the thing #1240 indicts.
#
#    Scope: a repo that does not track .githooks/pre-commit does not follow the
#    convention, so it is silent, like "no config = silent". "Cannot verify" is
#    only for a repo where the convention IS present and cannot be read.
#
#    The tree is untrusted: this runs at every SessionStart in whatever
#    directory is open, and its text becomes agent context. So:
#      - every finding is fixed text. No config value, path or file content
#        from the repo reaches the output (prompt injection);
#      - git runs with core.fsmonitor off and no optional locks, because a
#        repo-local core.fsmonitor is a command git would execute;
#      - a checkout not owned by this user gets no git at all;
#      - hook copies are compared with the COMMITTED blob, not the working
#        tree, which the repo could edit to match a planted copy.
hook_git() { GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$HOOK_TOP" "$@"; }
check_precommit_setup() {
  local repo="${CLAUDE_PROJECT_DIR:-$PWD}" fix="git config core.hooksPath .githooks"
  local unverifiable="cannot verify the pre-commit hook setup: the session checkout has a .githooks/pre-commit"
  local hooks_path common old_hook
  if ! HOOK_TOP=$(GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$repo" rev-parse --show-toplevel 2>/dev/null) || [ -z "$HOOK_TOP" ]; then
    [ -f "$repo/.githooks/pre-commit" ] &&
      FINDINGS+=("$unverifiable, but git cannot read the directory as a checkout — whether commits run it is unverifiable")
    return 0
  fi
  if [ ! -O "$HOOK_TOP" ]; then
    # canary:allow-untested a test cannot create a checkout owned by another user without root
    [ -f "$HOOK_TOP/.githooks/pre-commit" ] &&
      FINDINGS+=("$unverifiable, but the checkout is not owned by the current user, so the siren runs no git in it — whether commits run it is unverifiable")
    return 0
  fi
  hook_git ls-files --error-unmatch .githooks/pre-commit >/dev/null 2>&1 || return 0
  if ! hook_git cat-file -e HEAD:.githooks/pre-commit 2>/dev/null; then
    FINDINGS+=("$unverifiable that is tracked but not committed at HEAD, so there is no committed copy to compare with — unverifiable")
    return 0
  fi
  hooks_path=$(hook_git config --get core.hooksPath 2>/dev/null)
  if [ -z "$hooks_path" ]; then
    FINDINGS+=("core.hooksPath is unset in the session checkout, so commits run .git/hooks/pre-commit (a stale copy, or nothing) instead of the tracked .githooks/pre-commit — in that checkout, run: $fix")
  elif [ "${hooks_path%/}" != ".githooks" ]; then
    FINDINGS+=("core.hooksPath is set to a value other than .githooks in the session checkout, so commits may not run the tracked .githooks/pre-commit — inspect it with git config --get core.hooksPath; in that checkout, run: $fix")
  fi
  if ! hook_git cat-file blob HEAD:.githooks/pre-commit | cmp -s - "$HOOK_TOP/.githooks/pre-commit"; then
    FINDINGS+=("the working-tree .githooks/pre-commit in the session checkout differs from the committed one at HEAD, so commits run uncommitted hook code — review it: git diff HEAD -- .githooks/pre-commit")
  fi
  # --git-common-dir prints a path relative to the -C directory unless it is
  # elsewhere; resolve it here rather than lean on --path-format (git 2.31+).
  common=$(hook_git rev-parse --git-common-dir 2>/dev/null)
  case "$common" in
  /*) ;;
  *) common="$HOOK_TOP/$common" ;;
  esac
  old_hook="$common/hooks/pre-commit"
  # Only a copy that differs is a finding; none at all, or an identical one, is
  # not. It runs whenever core.hooksPath is unset, so the path fix alone leaves
  # it armed: the remedy also moves it aside.
  if [ -e "$old_hook" ] && ! hook_git cat-file blob HEAD:.githooks/pre-commit | cmp -s - "$old_hook"; then
    FINDINGS+=("the old-style hooks/pre-commit in the session checkout's common git dir differs from the committed .githooks/pre-commit — it is what commits run whenever core.hooksPath is unset; in that checkout, run: $fix && mv \"\$(git rev-parse --git-common-dir)/hooks/pre-commit\" \"\$(git rev-parse --git-common-dir)/hooks/pre-commit.stale\"")
  fi
}
HOOK_TOP=""
check_precommit_setup

emit_and_exit
