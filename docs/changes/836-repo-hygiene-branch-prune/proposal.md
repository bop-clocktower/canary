# Proposal: branch prune with an unpushed-work audit (#836)

**Status:** proposed **Issue:** #836 **Decision:** ADR 0022 (branches now,
worktrees later)

## Problem

Branch cleanup here has been hand-driven three times (58, 54, 13 branches), and
each time the risky judgment — merged versus carrying unpushed work — was
re-derived from scratch. ADR 0022 adopts `harness-repo-hygiene` as the cleanup
path, conditional on its unpushed-work audit using `git cherry` plus
`git ls-remote` rather than `git status`. A branch whose upstream is
`origin/main` hides its own unpushed commits from tracking state.

## Proposal

Ship `scripts/branch-prune.mjs`, a deterministic classifier that encodes the
audit ADR 0022 requires, so the harness skill (or a human) has a verified
deletion set to act on.

- **Classification:** a branch is a deletion candidate only when `git cherry`
  shows no commits absent from `origin/main`, or its PR is `MERGED` and the
  branch tip equals the PR head. A local branch must additionally match the tip
  `git ls-remote` reports, so unpushed commits are never lost.
- **Permanent protect-list:** `main`, `release/*`,
  `fix/mcp-tool-path-containment`, `fix/migrator-workflow-symlink-escape`. Never
  a candidate regardless of merge state.
- **Worktrees:** a branch checked out in any worktree, or named
  `worktree-agent-*`, is never a candidate. Worktree pruning stays deferred per
  ADR 0022 §3.
- **Dry-run by default.** `--apply-local` deletes local candidates only. There
  is no remote deletion flag; remote deletion is a human act.
- **CI:** a dogfood job runs the prune in dry-run and prints the remote deletion
  set, advisory.

## Success Criteria

1. The protect-list survives `--apply-local` even when fully merged.
2. A branch tracking `origin/main` with an unpushed commit is kept.
3. A squash-merged branch is a candidate only with a MERGED PR whose head equals
   the tip.
4. Branches checked out in a worktree are kept.
5. Dry-run is the default; no code path deletes a remote ref.
6. Only protected refs to examine exits 3 (abstention), never 0.

## Non-goals

Worktree pruning (#889 first); remote deletion; replacing the harness skill.
