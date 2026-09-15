# Plan: shell scripts are not guardian program source (#933)

Decision (human, 2026-09-14): stop treating shell scripts as program source.

## Tasks

1. Red: tests in `ts/test/guardian-heuristic-source-gate.test.ts` that check:
   - `isSourcePath` is false for `.sh`, `.bash`, `.zsh`, `.ps1` and `.psm1`
   - a changed `scripts/seed.sh` with no referencing test raises no pr-check
     finding
   - `filterHeuristicNoise` still keeps coverage- and graph-verified results on
     a shell path
   - the old `scripts/deploy.sh is source` case is removed on purpose
2. Green: remove the shell block from `SOURCE_EXTENSIONS` in
   `ts/src/guardian/diff-coverage/paths.ts` and rewrite the #413 doc comment.
   There is one set with no copy, so the heuristic filter and #936's
   coverage-unit floor both read it.
3. Docs: note the source floor and the shell exclusion in
   `docs/guides/pr-guardian.md`, and add a CHANGELOG `Changed` entry.
4. Gates from ts/: build, typecheck, format:check, test. Ratchets: check-arch,
   check-perf, entropy.

## Assumptions

- #936 is not merged when this starts. The coverage-unit test is therefore
  written against `filterHeuristicNoise`. Once #936 lands it reads the same set
  and needs no edit.
