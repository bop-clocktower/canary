# Fork Policy

This repository is the Capillary work-fork of the upstream
[oracle-test-ai-agent](https://github.com/bri-stevenski/oracle-test-ai-agent).
All generic improvements should flow upstream. Capillary-specific
content must never leak into upstream PRs.

## Two kinds of fork-only content

### 1. Whole paths

Anything under these directories is fork-only and never goes upstream:

- `capillary/` — Capillary-specific code (reserved; none yet)
- `docs/capillary/` — Capillary-specific docs (reserved; none yet)
- `.harness/capillary/` — Capillary-specific harness config (reserved)

The list lives in `FORK_ONLY_PATHS` at the top of
`scripts/upstream_sync.py`.

### 2. Inline blocks in shared files

For files that mix shareable and fork-only content (the roadmap is the
canonical example), wrap the fork-only sections with HTML comments:

```markdown
<!-- fork-only:capillary -->
## Fork-Specific (Capillary)

Some Capillary-only content here.
<!-- /fork-only -->
```

Rules (see the syntax in the fenced example above):

- Every opener needs a matching closer.
- No nesting.
- The key is free-form (`capillary` today; any `[A-Za-z0-9_-]+` works
  in case other variants appear later).

CI runs `python3 scripts/upstream_sync.py check` on every PR and fails
when markers are unbalanced or nested, so a typo cannot silently break
sanitization.

## Producing an upstream sync

When ready to push the next batch upstream:

```bash
python3 scripts/upstream_sync.py build
```

The script writes a sanitized copy of the working tree to
`.upstream-sync/` (gitignored). To open the PR upstream:

```bash
cd .upstream-sync
git init && git add -A && git commit -m "Sync from oracle-capillary"
# Push to a new branch on bstevenski/oracle-capillary and open a
# cross-fork PR into bri-stevenski/oracle-test-ai-agent:main.
```

Alternatively, use the manual flow that produced PR #17: create a
branch off `upstream/main`, `git checkout origin/main -- .`, run the
sync script's `build` mode against that worktree, then commit.

## What CI guarantees

- **Fork-side CI** (`fork-policy` workflow): markers are well-formed.
  It does **not** block fork-only content — that is allowed here by
  definition.
- **Upstream-side CI** (companion guard, see follow-up): rejects any
  incoming PR containing fork-only markers or paths. That is the
  actual wall; the fork-side check just keeps it usable.

## Why two layers

Catching marker typos on the fork is cheap and keeps the build mode
honest. Rejecting fork-only content upstream is what prevents leaks no
matter who opens the PR or how. Together they make the wall mechanical
rather than convention-based.
