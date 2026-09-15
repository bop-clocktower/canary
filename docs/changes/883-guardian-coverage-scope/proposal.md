# Guardian coverage scope for non-ts trees (#883 part c)

Implements the slice of
[ADR 0024](../../knowledge/decisions/0024-guardian-coverage-scope-non-ts-trees.md)
that PR #917 (parts a and b) did not ship. The earlier
`883-guardian-coverage-eligibility` plan covers only a and b and is not reused.

## What ADR 0024 still requires

| #   | Decision                                                          | This PR                  |
| --- | ----------------------------------------------------------------- | ------------------------ |
| 1   | Instrument `npm/` in the guardian coverage job                    | deferred                 |
| 2   | `pr-check` merges several lcov reports (union of lines)           | deferred                 |
| 3   | `canary.guardian.coverageExempt` for `scripts/`, `agents/skills/` | shipped                  |
| 4   | An exempt skip is disclosed with count and globs, never a pass    | shipped                  |
| 5   | Exemptions are temporary per tree                                 | recorded (entry reasons) |

## Smallest shippable slice (3 + 4)

- `loadGuardianConfig` reads `coverageExempt`: bare globs or `{glob, reason}`. A
  malformed entry warns loudly (SC-8), never drops silently.
- `resolveCoverageWithInput` takes a `coverageExempt` predicate. Exempt units
  skip the report tier and leave `unitsTotal`, so they are neither stale nor a
  scope gap. They still run through the graph and heuristic tiers.
  `CoverageInputState` gains `unitsExempt` and `exemptGlobs`, which the json and
  analysis surfaces already carry via the `coverage` block.
- Comment/text headline: an all-exempt PR reads
  `⚠️ coverage skipped: N file(s) coverage-exempt (<globs>)`; a mixed PR adds a
  `- N files: skipped as coverage-exempt (<globs>)` count and never shows a
  plain ✅. The findings path gets a one-line disclosure too.
- Exit code for an all-exempt PR: unchanged gate logic (exit 0 on a soft gate
  with no findings). ADR 0024 leaves 0 vs 3 open provided the comment is not a
  pass; the headline guarantees that.
- `harness.config.json` records `scripts/**` and `agents/skills/**` with
  reasons.

## Success criteria

- A PR touching only `scripts/` shows a counted, named skip, not ✅ and not the
  zero-match abstention.
- Exempt units are still judged below the coverage tier.
- No change to behaviour when `coverageExempt` is absent.

## Follow-ups (not in this PR)

1. Decision 1: add an `npm/` lcov run
   (`node --test --experimental-test-coverage --test-reporter=lcov`) to the
   guardian coverage job; measure the duration against the #760 ratchet; extend
   the "verify report exists" step.
2. Decision 2: repeatable `--coverage` / `coveragePaths`, per-report path
   anchoring, union-of-lines merge, with overlapping-file and mismatched-root
   tests.
3. Once each exempt tree emits lcov, delete its `coverageExempt` entry.
