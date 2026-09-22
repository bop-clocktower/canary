# Plan — #1074 phase 1: split `ts/src/history` along the command-family seam

Spec: [`../proposal.md`](../proposal.md). Base: `origin/main` @ `76d3f19b`.
Route: `feature` (brainstorming -> autopilot). Single phase; no checkpoint
requires a human because the design fork (split, not raise/refresh/allow) was
decided before the lane started.

## Constraints that shape every task

These are not style preferences — each one is a red required check that the
local four gates cannot see, which is the whole subject of #1074.

| Constraint                                                                                                          | Source                                                      | Consequence if broken                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Module LOC <= 1800, per **directory** (subdirectories are their own modules; `.test.ts` excluded; comments counted) | `harness.config.json` `architecture.thresholds.module-size` | `check-arch` new violation                                       |
| File length <= 300 lines                                                                                            | `harness check-perf`                                        | perf ratchet fails on a **new** finding identity                 |
| Imports <= 15 per file                                                                                              | `harness check-perf`                                        | same                                                             |
| Coupling ratio <= 0.7, **allowance globbed at `ts/src/**/cli.ts`**                                                  | `.harness/perf-baseline.json` `deltaAllowances`             | a non-`cli.ts` helper module trips coupling as a new finding     |
| Layer binding is by **filename**, `ts/src/**/*cli*.ts` first-match                                                  | `harness.config.json` `layers`                              | a `history`-layer file importing `cli-common` fails `check-deps` |

No `deltaAllowances` entry, no baseline refresh, no ceiling raise. The perf
delta rule is unwaivable (`--admin` cannot bypass a red required check).

## Tasks

| #   | Task                                                                                                                                                          | Verification                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Measure the baseline: probe `ts/src/history` module LOC, count `cli.ts` imports, record base SHA                                                              | probe reads 1800; `grep -c '^import'` reads 15                                                    |
| 2   | Create `ts/src/history/cli-deps.ts` with `HistoryDeps` + `defaultHistoryDeps`; re-export the type from `cli.ts`                                               | `tsc --noEmit` clean; no test import changes                                                      |
| 3   | Create `reporting/cli.ts` — `flaky`, `timeline`, `summary`, plus the shared read-side denominator guard `abstainOnEmptyHistory` and the run-count flag parser | suite green; file <= 300 lines                                                                    |
| 4   | Create `publish/cli.ts` — `push`, `migrate`, plus the shared `RUN_FIELDS` / `RESULT_FIELDS` / `pick` projection                                               | suite green; file <= 300 lines                                                                    |
| 5   | Create `record/cli.ts` + `record/outcome-cli.ts` — the command and its outcome rendering                                                                      | suite green; both files <= 300 lines                                                              |
| 6   | Reduce `cli.ts` to the command root: build the program, call the three registrars, normalize usage exits                                                      | `grep -c '^import'` <= 10; no `.command(` in the root                                             |
| 7   | Add `ts/test/history-seam.test.ts` to defend the headroom at the desk                                                                                         | 8 tests pass; the family-module denominator asserts >= 4 so the per-file checks cannot be vacuous |
| 8   | Demonstrate acceptance: plant a 147-line `prune/cli.ts` + root registration, measure all four limits, remove it                                               | measured and recorded in the spec                                                                 |
| 9   | Reproduce every CI-only ratchet locally against `76d3f19b` in a detached base worktree                                                                        | all green (see below)                                                                             |
| 10  | Four gates from `ts/`, exit codes read directly (never through a pipe)                                                                                        | `build`, `typecheck`, `format:check`, `test`                                                      |

## Ordering rationale

Tasks 3 -> 4 -> 5 run read-side first deliberately: `reporting` is the group
with no shared state outside the store, so it is the cheapest move to revert if
the seam turns out wrong. `record` goes last because it is the largest and the
only one that needed a second file.

## Known correction during execution

Task 4 and 5 were originally one task — a single `ingest/cli.ts` holding
`record`, `push` and `migrate`. It came out at 606 lines and the perf ratchet
failed it against the merge base with `File has 606 lines (threshold: 300)`, a
new finding because the path was new. Split into `record/` and `publish/`, which
were separate concerns anyway. This is recorded rather than tidied away: it is
the exact failure mode #1074 was filed to stop someone discovering mid-PR, and
it was caught here only because task 9 reproduces the CI-only ratchet locally.

## Verification commands

From the repo root, with a detached base worktree at the merge base (the two
scans must run under different roots, and the ratchets are handed both):

```bash
harness check-perf > perf-head.txt 2>&1 || true
node scripts/perf-ratchet.mjs --report perf-head.txt --cli-version 12.10.0 \
  --report-root "$PWD" --base-report-root <base-worktree> --base-report perf-base.txt
harness cleanup --findings-json > entropy-head.txt 2>&1 || true
node scripts/entropy-ratchet.mjs --report entropy-head.txt --cli-version 12.10.0 \
  --base-report entropy-base.txt
harness check-docs --json --min-coverage 0 > docs-head.json
node scripts/docs-ratchet.mjs --report docs-head.json --base-report docs-base.json
harness check-arch --json > arch-report.json
node scripts/arch-verdict.mjs arch-report.json
harness check-deps
```

From `ts/`: `npm run build`, `npm run typecheck`, `npm run format:check`,
`npm test`. There is no `lint` script.

## Out of scope

- Moving the persistence adapters (`store.ts`, `ndjson-store.ts`,
  `supabase-store.ts`, `async-store.ts`, `schema.ts`, `record.ts`). Rejected as
  the seam in the spec; ~20 external import sites, and not what grows.
- Any behavior, option, output or exit-code change.
- The repo-wide aggregate `module-size` arch floor. Any PR that adds code moves
  it; this one does not, and it is not the `history` ceiling #1074 is about.
