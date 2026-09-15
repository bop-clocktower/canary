# Plan: retire the remaining Python-port framing in ts/src (#970)

Scope was settled by a human before this lane started: all three parts of #970.

## Measured on origin/main (aae93dd)

- Header grep
  `faithful (typescript |ts )?port|python original|agent/[a-z_/]+\.py` over
  `ts/src`: 52 lines.
- `py[A-Z]*` identifiers over `ts/src` (whole-word): 202 lines.
- `faithful port|oracle` over `ts/test` (out of scope, counted only): 29 lines.

## Tasks

1. Rename the private `py*` helpers to intent-revealing names. Reuse a shared
   helper only when it behaves the same. `formatWithDecimalPoint` and
   `parseStrictInt` do not, so the private copies are renamed instead. Commit:
   `refactor(ts): rename private py* helpers ...`.
2. Rewrite every matching module header so it states the module's own contract,
   or delete the sentence when it only pointed at the old file. Keep behavior
   notes (for example `str.splitlines()`). Commit.
3. TDD the MCP change: pin the `canary__list_frameworks` description in
   `ts/test/mcp-server.test.ts` (fails first), then change the text to the
   bundled `data/frameworks/registry.json` path. Commit.
4. Gates from `ts/`: build, typecheck, format:check, test. Then
   `harness check-arch --json` (`regressions: []`, `newViolations: []`) and the
   entropy/perf ratchets against a merge-base scan.
5. Provenance, rebase on origin/main, push, open the PR.
