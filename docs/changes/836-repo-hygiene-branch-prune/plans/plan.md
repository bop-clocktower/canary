# Plan: branch prune (#836)

1. **Red.** `ts/test/branch-prune.test.ts`: fixture repo with a bare origin;
   cases for dry-run default, no remote deletion, protect-list, cherry/ls-remote
   classification (including the origin/main-tracking hazard), merged-PR
   exception, worktree branches, exit 3 / exit 2.
2. **Green, pure logic.** `scripts/lib/branch-classify.mjs`: `isProtected`,
   `classifyLocal`, `classifyRemote` over plain facts. Small functions to add no
   perf findings.
3. **Green, I/O.** `scripts/branch-prune.mjs`: gather refs, worktree list,
   `git cherry`, `git ls-remote`, PR states (`--pr-states` file or
   `gh pr list`); print text or `--json`; `--apply-local` with `git branch -D`
   after re-checking the protect-list.
4. **CI.** Advisory dry-run job in `.github/workflows/dogfood.yml`.
5. **Docs.** AGENTS.md names the cleanup path and the script.
6. **Ratchets.** Both new modules in `entropy.entryPoints` and
   `performance.entryPoints`; re-measure perf; no `maxFindings` change.
7. **Gates** from `ts/`: build, typecheck, format:check, test.
