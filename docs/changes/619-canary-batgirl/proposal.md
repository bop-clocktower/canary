# canary-batgirl: a team quality scorecard that resists gaming (#619)

**Keywords:** scorecard, Goodhart, escaped defects, coverage-verified, closure
audit, quarantine ledger, vacuous tests, run-history, abstention, team-level,
report-only, skill

## Overview

Issue #619 (ideation rank 14, candidate 14 in
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`) asked for "streaks,
badges, and rank derived from canary audit scores". The ideation recorded the
sharpest objection in its batch: Goodhart's law. Score engineers on canary
metrics and they optimise the score, and the cheapest way to raise almost any
coverage-derived score is to add assertion-free tests. A naive scorecard would
manufacture the exact problem canary exists to detect (`STRATEGY.md`, "Target
problem": line coverage can be maxed out by assertion-free tests).

This spec keeps the goal of STRATEGY.md track 5 ("Quality made legible": turn
evidence into durable signal that reads to people who do not open the code) and
answers the objection by construction. canary-batgirl is a **team-level
scorecard** built only from signals whose cheapest gaming path is not "add green
tests". Every candidate signal considered is listed below with the cheapest way
to game it, and the shipped test suite plants a change that adds many
assertion-free and vacuous passing tests and asserts that no dimension improves.

It is a self-contained report-only skill under `agents/skills/claude-code/`,
like `canary-savant` and `canary-cassandra`. It reads artifacts other canary
tools already write. It runs none of them, needs no network, and is never a
gate.

### Out of scope (non-goals)

- **Anything per developer.** No per-person score, rank, leaderboard, streak or
  badge, and no output keyed by commit author. No input is aggregated by author,
  not even as an intermediate. The `author` field of a katana ledger row is
  never read. (Maintainer decision; see D1.)
- **A composite score.** There is no single number. See D3 for why an average is
  itself a gaming path.
- **Any gate.** Findings never change the exit code. There is no `--strict`.
- **Trends over time, streaks, or history windows.** v1 is a snapshot over the
  inputs it is given. A trend is a follow-up, not part of this issue.
- **Running any producer** (batwoman, guardian, cassandra, katana, history
  record). batgirl reads their output files only.
- **The prefix drop** of the `canary-*` folder convention (#1773).

## Decisions made

Autonomous lane (roadmap-fleet run `roadmap-fleet-2026-11-27`): D1, D2, D6 and
D8 were set by the maintainer in the lane brief. The rest took the recommended
option and are recorded as assumptions in `provenance.json`.

| #   | Question                                 | Decision                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Developer or team?                       | **Team (repository) only.** Nothing is keyed by, grouped by, or printed with an author.                                                                                                                                                                                                                                                                                                | Maintainer decision. A per-person score is the strongest incentive to game, and it turns a quality signal into a performance review.                                                                                                                    |
| D2  | Which signals?                           | Only signals whose cheapest gaming path is **not** adding green or assertion-free tests (see the signal table). Six dimensions ship.                                                                                                                                                                                                                                                   | Maintainer decision; the ideation's stated safety condition.                                                                                                                                                                                            |
| D3  | One composite score?                     | **No.** Each dimension stands alone with its own value, direction and denominator.                                                                                                                                                                                                                                                                                                     | An average over assessed dimensions rises when a bad dimension's input is withheld: the dimension drops out and the mean goes up. Treating a missing dimension as zero or perfect is forbidden (D6). So any composite is gameable by withholding input. |
| D4  | Ratios or counts?                        | A dimension whose denominator a developer can pad cheaply is reported as an **absolute count** (vacuous tests, unexplained switch-offs, red mainline commits). A ratio is used only when its denominator is itself hard to pad (escaped vs caught defects, coverage-matched units, claiming closure verdicts).                                                                         | A ratio over tests, rows or commits is diluted by adding more green tests, ledger rows or green commits. A count is not.                                                                                                                                |
| D5  | Where do inputs come from?               | Files on disk, each behind one flag. Four have the conventional default path their producer writes; two (batwoman, cassandra) have no on-disk convention and are read only when named.                                                                                                                                                                                                 | Same records manhunter reads (`docs/changes/611-canary-manhunter/proposal.md`, D3).                                                                                                                                                                     |
| D6  | Missing input?                           | A dimension with no backing data prints **not assessed**, with the reason, never zero or perfect. No dimension assessed at all: exit 3 (abstained, ADR 0009).                                                                                                                                                                                                                          | Maintainer decision; [ADR 0009](../../knowledge/decisions/0009-exit-3-reserved-for-abstained.md).                                                                                                                                                       |
| D7  | A named input that cannot be read?       | Exit 1 with the path named. A default path that is absent is a not-assessed dimension. A file that reads but does not parse, or does not have the expected shape, is not assessed with the reason (cannot-verify is a finding).                                                                                                                                                        | Mirrors canary-ivy's split and manhunter's dark sections.                                                                                                                                                                                               |
| D8  | Exit codes                               | `0` at least one dimension assessed, whatever the values; `3` none assessed; `1` I/O (named input unreadable, `--out` unwritable); `2` usage.                                                                                                                                                                                                                                          | Report-only, never a gate (maintainer decision).                                                                                                                                                                                                        |
| D9  | Oversized input?                         | Every read is bounded: bytes per file, entries per array, lines per history store, files per directory. An input over a limit is **not read**, and its dimension is not assessed with the limit named. No partial value is computed from a truncated input.                                                                                                                            | A value computed from the first N rows misrepresents the whole. Bounds keep every scan linear.                                                                                                                                                          |
| D10 | Escaping                                 | One helper module (`text.mjs`): `plain` strips ANSI sequences and control characters, collapses line breaks, clamps length; `md` is `plain` plus Markdown-metacharacter escaping. Every value from an input file, a path or an error message passes through it before Markdown, JSON values, stdout or stderr. JSON keys are batgirl's own constants and are never derived from input. | Paths and parse errors carry hostile text from a branch. Keeping keys fixed removes the key-collision class entirely.                                                                                                                                   |
| D11 | Duplicate closure reports for one issue? | Counted once (the first by sorted file name); the number of duplicates is printed.                                                                                                                                                                                                                                                                                                     | Re-running batwoman on one good closure must not pad the exercised share.                                                                                                                                                                               |
| D12 | Skill shape                              | Self-contained ESM skill, `cli.mjs` at five imports, input reading and output split into sibling modules (canary-ivy's layout, PR #1778).                                                                                                                                                                                                                                              | Uses no perf coupling allowance and touches no `ts/src` module (the history module has zero headroom).                                                                                                                                                  |
| D13 | Closing keyword                          | The PR closes #619. The issue title says "developer and team"; the developer half is deliberately not built (D1), and that is a decision about the issue's scope rather than a slice of remaining work.                                                                                                                                                                                | Nothing further is planned for the developer half, so leaving #619 open would track work nobody intends to do.                                                                                                                                          |

## Signals considered

Every candidate, with the cheapest way to raise it without improving quality.
"Adds green" means the gaming path is adding passing tests, rows or commits that
prove nothing, the move the ideation objection names.

### Shipped (six dimensions)

| Dimension (id)                                      | Source                                                     | Value                                                                                                            | Better | Cheapest gaming path, and what limits it                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escaped-defect ratio (`escaped-defects`)            | `.canary/escapes.json` (manhunter's escape log)            | escapes / (escapes + caught) since `tracked_since`                                                               | lower  | Under-record escapes, or pad `caught` with invented pre-release defects. Both are hand edits to a reviewed file, each entry needs an id, and an escape is usually reported by someone outside the team. Adding tests changes neither list.          |
| Coverage-verified share (`coverage-verified-share`) | guardian records, `.harness/analyses/`                     | Σ `coverage.unitsMatched` / Σ `coverage.unitsTotal` over guardian records that judged ≥1 unit                    | higher | Forge a coverage report that names every changed file. Tests do not move it: the report either speaks to a changed unit or it does not, whether or not a test asserts anything.                                                                     |
| Closure exercise share (`closure-exercise`)         | batwoman `--json` reports (file or directory)              | exercised / (exercised + not-exercised), one report per issue; abstain, no-probe and not-applicable shown beside | higher | Trigger a dormant workflow by hand after the merge, which is the behaviour the signal rewards. Turning not-exercised into abstain (break `gh`) shows as a larger abstain count printed next to the share. Duplicate reports are counted once (D11). |
| Unexplained switch-offs (`unexplained-switch-offs`) | katana ledger, `.canary/quarantine.json`                   | count of ledger rows with no cause, an unrecognised cause, or a cause that requires an issue and has none        | lower  | Write a cause on every row. That is an accountable, reviewed act rather than free; the cause mix is printed so a wall of `obsolete` is visible. A count, not a share, so padding the ledger with caused rows changes nothing.                       |
| Vacuous tests (`vacuous-tests`)                     | cassandra `--json` report                                  | count of distinct tests with a VAC finding                                                                       | lower  | Rewrite a vacuous test to evade the four VAC rules, or delete it (a deletion lands in the katana ledger). Adding assertion-free tests leaves the count unchanged, and adding vacuous ones raises it.                                                |
| Red mainline commits (`red-mainline-commits`)       | run-history store, `test-results/reports/history-v2.jsonl` | count of distinct commits on `--branch` (default `main`) with any recorded run where `failed > 0`                | lower  | Record history only for green runs, or skip the failing test (the skip lands in the ledger). Re-running to green does not help: any red run marks the commit. Adding green commits leaves the count unchanged.                                      |

### Rejected

| Candidate                                                 | Cheapest gaming path                                                                                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaks, badges, rank (the original premise)              | Per developer (D1). Streaks reward a stream of trivial green commits.                                                                                                                                                       |
| Any per-developer score or leaderboard                    | Maintainer decision (D1). Also the strongest incentive to game any signal below.                                                                                                                                            |
| Line or branch coverage percentage                        | Adds green: an assertion-free test that executes the lines.                                                                                                                                                                 |
| Test count, tests added per period, test-to-code ratio    | Adds green: write trivial tests.                                                                                                                                                                                            |
| Pass rate (passed / total)                                | Adds green: dilute with trivial passing tests, or skip the failing ones.                                                                                                                                                    |
| Assertion count or assertion density                      | Adds green: `expect(true).toBe(true)` or redundant assertions.                                                                                                                                                              |
| Vacuous share (cassandra findings / tests checked)        | Adds green: a test with zero assertions is not a cassandra finding (it is `review-test` LINT-006), so assertion-free tests dilute the share.                                                                                |
| Flaky rate per test result                                | Adds green: dilute with stable trivial tests.                                                                                                                                                                               |
| Red mainline share (red commits / commits)                | Adds green: push a stream of small green commits.                                                                                                                                                                           |
| Guardian finding count (untested changed units)           | Adds green: an assertion-free test covering the unit makes the finding disappear.                                                                                                                                           |
| Coverage-verified **finding** share (STRATEGY.md wording) | Adding untested code under coverage adds coverage-verified findings and raises it; covering units with assertion-free tests removes them. The unit-level share above measures the same evidence tier without either effect. |
| `canary ci-ready` score                                   | Adds green: two of its five checks are static assertion tiers from the test inventory.                                                                                                                                      |
| Quarantine-row share (unexplained / all rows)             | Pad the ledger with caused rows.                                                                                                                                                                                            |
| Mutation score                                            | No canary-owned artifact to read; narrowing the mutation scope in config is cheap and invisible in a report.                                                                                                                |
| Suite runtime                                             | Not a quality signal; delete slow tests.                                                                                                                                                                                    |
| Closed-issue count or velocity                            | Close issues with a keyword (batwoman's founding case).                                                                                                                                                                     |

## Technical design

### Dimension model

```js
{
  id: 'red-mainline-commits',     // fixed, batgirl's own
  title: 'Red mainline commits',  // fixed
  better: 'lower',                // 'lower' | 'higher'
  kind: 'count',                  // 'count' | 'ratio'
  status: 'assessed',             // 'assessed' | 'not-assessed'
  value: 2,                       // number when assessed; null otherwise
  basis: '2 of 31 commits on main had a failing run', // plain sentence
  source: 'test-results/reports/history-v2.jsonl',     // escaped path
  reason: null,                   // why not assessed; null when assessed
  detail: { ... }                 // fixed keys, numbers only
}
```

A ratio's `value` is in `[0, 1]`; Markdown prints it as a percentage. A count's
`value` is a non-negative integer. `detail` carries the numbers behind the value
(for closure: all five batwoman statuses; for the ledger: the cause mix) and
never a string from an input.

### Per-dimension rules

- **escaped-defects.** Reads
  `{schema_version: 1, tracked_since, escapes: [], caught: []}`. `caught` is the
  one field this spec adds to manhunter's escape log (each entry
  `{id, summary, found_at}`, same as an escape); manhunter ignores it. Not
  assessed when `tracked_since` is not an ISO date, either array is missing, or
  both are empty.
- **coverage-verified-share.** Reads `canary-pr-guardian-*.json` in the
  directory. A record counts when `source` is `canary-pr-guardian`,
  `schemaVersion` is a string, `abstained` is not true, `checked > 0`, and
  `coverage` has integers `0 <= unitsMatched <= unitsTotal`, `unitsTotal > 0`.
  Records that do not count are tallied by reason and printed. Not assessed when
  no record counts.
- **closure-exercise.** Reads one batwoman `--json` report or every `*.json` in
  a directory. A report counts when `issue` is an integer and `files` an array.
  One report per issue (D11). Not assessed when no file made a claim
  (exercised + not-exercised = 0), with the other three counts printed.
- **unexplained-switch-offs.** Reads `{entries: []}`. Causes and the
  issue-requiring subset mirror `canary-katana/scripts/ledger.mjs`. Reads
  `cause` and `issue` only. Not assessed when the ledger has zero rows.
- **vacuous-tests.** Reads cassandra's `--json` shape (`schema_version: 1`,
  `findings`, `summary.tests_checked`). Distinct tests are keyed by `file` +
  `snippet` (the test name). Not assessed when `summary.abstained` is true or
  `tests_checked` is 0.
- **red-mainline-commits.** Reads the NDJSON store (schema versions 2 and 3,
  mirroring `ts/src/history/record.ts`). Reads `branch`, `commit_sha`, `failed`
  per run. Not assessed when no run is on the branch, or a line does not parse
  (named by line number).

### Limits (D9)

| Limit               | Value   |
| ------------------- | ------- |
| bytes per file      | 32 MiB  |
| entries per array   | 100 000 |
| history lines       | 200 000 |
| files per directory | 500     |

### Output

- Markdown by default, in the batgirl voice (`voice/profiles/batgirl.md`): opens
  with the sweep line (`SWEEP: team scorecard · 6 dimensions · 4 assessed`), one
  table row per dimension, a not-assessed ledger with reasons, and closes on the
  gap count. It states that nothing is per person and that there is no
  composite.
- `--json`: `{schema_version: 1, abstained, dimensions: [...]}`.
- `--out PATH`: also writes the printed text, creating parent directories; a
  failure prints `cannot write artifact: ...` and exits 1 (canary-ivy and
  canary-question convention).

### File layout

| File                                                                                     | Role                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [cli.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/cli.mjs)             | entry point, flags, exit codes (five imports)              |
| [inputs.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/inputs.mjs)       | resolves each flag to a bounded read                       |
| [read.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/read.mjs)           | bounded file, directory and JSON reads                     |
| [dimension.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/dimension.mjs) | dimension metadata and constructors                        |
| [evidence.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/evidence.mjs)   | escaped-defects, coverage-verified-share, closure-exercise |
| [suite.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/suite.mjs)         | unexplained-switch-offs, vacuous-tests                     |
| [mainline.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/mainline.mjs)   | red-mainline-commits                                       |
| [scorecard.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/scorecard.mjs) | assembles the report, JSON rendering                       |
| [render.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/render.mjs)       | Markdown rendering                                         |
| [output.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/output.mjs)       | produce the printed text, write `--out`                    |
| [text.mjs](../../../agents/skills/claude-code/canary-batgirl/scripts/text.mjs)           | the one escaping helper (D10)                              |

## Integration points

### Entry points

- New skill `agents/skills/claude-code/canary-batgirl/` (`SKILL.md`,
  `scripts/*.mjs`), run as `canary skills run canary-batgirl -- [flags]` or
  directly via `scripts/cli.mjs`.

### Registrations required

- `.claude-plugin/plugin.json` skills list.
- `harness.config.json`: `entropy.entryPoints` and `performance.entryPoints`
  gain `scripts/cli.mjs`. No limit, baseline or allowance changes.
- `agents/skills/package.json` `format:check` glob and
  `agents/skills/vitest.config.ts` coverage `include`.

### Documentation updates

- `docs/naming-registry.md`: `canary-batgirl` row `reserved` to `shipped`.
- `docs/roadmap.md`: the canary-batgirl row links this spec and plan, status
  done.
- `agents/skills/README.md`: tree entry, Quality list entry, the bundled-CLI
  list.
- `CHANGELOG.md` `[Unreleased]`.

### Architectural decisions

None rises to a standalone ADR. D1 and D2 are maintainer decisions recorded in
the lane brief and this spec; D3 and D4 are design rules local to this skill.

### Knowledge impact

- Concept: **gaming path**, the cheapest way to move a metric without the
  quality it stands for; a signal is admissible only when that path is not "add
  green".
- Relationship: batgirl consumes the escape log (manhunter), guardian analysis
  records, batwoman reports, the katana ledger, cassandra reports and the
  run-history store, and produces none of them.

## Success criteria

1. When no input is present, the CLI prints every dimension as not assessed and
   exits 3; it prints no value.
2. When a dimension's input is absent, that dimension prints `not assessed` with
   a reason and its `value` is `null`, never 0, 100% or any number.
3. **Goodhart invariant:** given a baseline workspace with every input present,
   when a planted change adds 200 assertion-free passing tests and 50 vacuous
   passing tests (reflected in the history store, the cassandra report, a
   guardian record and a batwoman report as those producers would record it), no
   dimension's value improves and no dimension changes status.
4. Per-dimension dilution: adding N green commits leaves `red-mainline-commits`
   unchanged; raising `tests_checked` with the same findings leaves
   `vacuous-tests` unchanged; adding caused ledger rows leaves
   `unexplained-switch-offs` unchanged; a duplicate batwoman report leaves
   `closure-exercise` unchanged.
5. No output (Markdown, JSON, stdout, stderr) contains a synthetic author name
   planted in the ledger or the history store, and no JSON key contains
   `author`, `rank`, `streak` or `badge`.
6. If a path or a parse error carries ANSI escapes, control characters, line
   breaks or Markdown metacharacters, the Markdown output contains none of them
   unescaped and adds no line; JSON values and stderr carry no control
   character.
7. If an input exceeds a limit, the dimension is not assessed with "not read"
   and the limit named, and no partial value is computed.
8. A named input that does not exist exits 1 naming it; an unwritable `--out`
   exits 1 with `cannot write artifact`.
9. No skill source constructs a `RegExp` from input text.
10. The CLI passes the shared skill-CLI conformance suite.

## Implementation order

1. Escaping helper and bounded reads.
2. Dimension model and the six dimension evaluators.
3. Scorecard assembly, Markdown and JSON rendering, CLI and `--out`.
4. Goodhart invariant and abuse tests.
5. Registrations and documentation.
