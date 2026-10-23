# Plan: scope the pre-commit security-ledger step to its inputs (#1446)

Refs #1446 (part 2 of 3). Parts 1 and 3 are upstream harness CLI defects and
are filed upstream, not patched here.

## Root cause

`.githooks/pre-commit` step 4 built its trigger set as "every staged file
except the two ledger files", then ran `scripts/security_ledger.mjs` and
`git add`ed `.harness/security/timeline.json` and `docs/SECURITY_LEDGER.md`.
That set is the complement of the generator's real inputs:

- `scripts/security_ledger.mjs` reads one data input, the timeline, and
  writes two outputs: the trimmed timeline and the rendered ledger. It reads
  no findings file and no config.
- So any unrelated commit regenerated the ledger and staged both files,
  including any snapshot a local `harness check-security` run had appended
  to the timeline (part 1 of the issue).
- A commit staging only the timeline did not trigger a refresh, so the
  stale-pair case the step exists for was the one case it skipped.

## Fix

- Trigger only when the commit stages the timeline, the ledger, or
  `scripts/security_ledger.mjs`. The ledger is included so a hand edit is
  re-rendered rather than committed.
- If the refresh fails, print that it failed and do not restage. The old
  `2>/dev/null || true` swallowed the failure silently.

## Is anything lost? (CI stays the canonical writer)

- `harness-security.yml` runs `harness check-security`, then
  `node scripts/security_ledger.mjs`, on every push to `main`, and
  force-pushes the refreshed pair to `chore/security-ledger` for a human PR.
  This is the canonical source of new snapshots.
- `harness-quality.yml` "Security Ledger Freshness" regenerates on every PR
  and fails if the committed pair is stale. A PR that stages the timeline is
  still refreshed locally by the hook, so it passes the guard.
- Unrelated commits never needed a refresh: the committed pair is already
  fresh on `main` (the freshness guard enforces this), and the trim is
  idempotent.

## Tests added

`ts/test/precommit-ledger-scope.test.ts` runs the real hook and real ledger
script in a throwaway git repo:

1. Unrelated commit with a stale committed ledger: the ledger is not
   regenerated or staged (`git status --porcelain` clean for both files).
2. Unrelated commit with a stray local timeline snapshot: the snapshot stays
   an unstaged edit, byte-identical, and the ledger is not rebuilt from it.
3. Timeline staged: ledger refreshed and staged, nothing left unstaged.
4. Ledger script staged: ledger refreshed (preservation case).

Before the fix, 1 to 3 fail and 4 passes. After, all pass. Revert-and-fail
verified.

## Assumptions and defaults taken

- When the timeline is staged, the hook restages the whole working-tree file
  after trimming, as before. A partially staged timeline would have its
  unstaged hunks staged too. That edge case is unchanged from the old
  behaviour and is not worth extra code for a generated file.
- The AGENTS.md "First-time clone setup" bullet named the long-gone Python
  script and the old trigger. It is updated. The same section's claim that
  the hook "does two things" (it does four) predates this change and is left
  alone as out of scope.
- Parts 1 (`check-security` writes tracked state) and 3 (perf ratchet scans
  gitignored paths) are filed upstream. No local workaround, by decision F2
  option a.
