# Plan: rename the remaining py\* helpers (#964)

Single-phase, behavior-preserving rename. No design decisions beyond naming.

## Re-measure (origin/main 2e86e1a)

`git grep -n -E '\b(pyInt|pyFloat|pySlice)\b' -- ts` found:

- `pyInt` exported from `ts/src/guardian/diff-coverage/types.ts`, used in
  `formats/cobertura.ts`, `formats/coverage-json.ts`,
  `formats/coverage-json-lint.ts`, `report-tier.ts`.
- `pyFloat` exported from `ts/src/util/round.ts`, used in `analysis/reports.ts`,
  `history/cli.ts`, `util/round.test.ts`, and a comment in
  `ts/test/history-cli-branches.test.ts`.
- `pySlice`: one private copy, in `ts/src/core/pattern-healer.ts` (not in
  `company-knowledge.ts` / `workflow-discovery.ts` as the issue says; #962
  already removed or never had those copies).

No references in `npm/`, `scripts/`, `agents/`. `docs/` mentions are historical
records (a decision log and #962's plan) and stay unchanged.

## Renames

| Old       | New                      | Why the name                                              |
| --------- | ------------------------ | --------------------------------------------------------- |
| `pyInt`   | `parseStrictInt`         | strict base-10 parse, `null` on anything else             |
| `pyFloat` | `formatWithDecimalPoint` | integer values gain `.0`, others render as-is             |
| `pySlice` | `takeCodePoints`         | first `n` code points (not UTF-16 units); no negative idx |

## Tasks

1. Rename identifiers at definition and every call site.
2. Rewrite the `parseStrictInt` / `formatWithDecimalPoint` doc comments to
   describe behavior, not Python. Leave the `takeCodePoints` comment text alone
   (its wording belongs to #965).
3. prettier --write; gates from `ts/`: build, typecheck, format:check, test.
4. Entropy ratchet and `harness check-arch --json` not worse than main.

## Out of scope

`pyFloatStr` (core/ticket-updater.ts), `pyIntFromValue` (guardian/pr-check.ts),
and the #970 list; "oracle" comments (#965).
