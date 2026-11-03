# Deterministic `canary critical-areas` (#1529)

**Keywords:** critical-areas, katana, churn, importers, coverage, abstention,
degraded, risk-score

## Overview

`canary-katana` alarms only against `.canary/critical-areas.json`. Nothing
deterministic writes that file: `canary-critical-areas` is a prompt skill, and
its command points at an agent that does not exist
(`commands/canary-critical-areas.md:9`). So katana runs degraded in every fresh
worktree, and its degraded line does not say how to fix that.

Goals:

1. Ship `canary critical-areas`, which ranks tracked source files by churn,
   importers and, when a report is present, coverage, and writes
   `.canary/critical-areas.json` or a given path.
2. Point the command at the skill instead of a missing agent.
3. Make katana's degraded line name the generator command.

## Non-goals

- Staleness logic. `generated` and `base` are written for #1325 to read later;
  nothing here reads them.
- Indirect links and rename detection in katana (#1528).
- Replacing the prompt skill's judgement output. Business-critical flags, the
  harness graph signals and `--diff` scoping stay in the skill.
- tsconfig `paths` resolution, or any bare-package import resolution. The
  importer count is documented as approximate.
- Flags beyond `--root`, `--out` and `--coverage`, such as `--top` or a window.
- Changing the shared contract in `agents/skills/lib/contracts/`. Its schema
  already tolerates unknown fields (`critical-areas.v1.schema.json`).
- Teaching katana to find the file without `--critical-areas`.

## Decisions made

Brainstorming ran autonomously inside a roadmap-fleet lane. The human settled D1
and D2 at batch confirmation. The rest are recommended defaults, recorded as
assumptions in `provenance.json`.

| #   | Question                        | Chosen                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                   |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Signals                         | Churn and importers, plus coverage when present. Absent is `null`, never `0`                                                                                                                           | Human decision. A `0` would read as "measured, and untested".                                                                                                                                                                                                         |
| D2  | Output                          | `.canary/critical-areas.json`, or `--out <path>`                                                                                                                                                       | Human decision. It is where `ts/src/ci-ready-cli.ts`, `ts/src/analysis/enrich/area.ts` and `ts/src/briefing/inputs.ts` already look.                                                                                                                                  |
| D3  | Score                           | `0.5 * churn + 0.5 * importers`, each normalized to the largest in scope, plus `0.15 * (1 - coverage)` when coverage is known. Capped at 1.0                                                           | The skill's formula with `business_critical` (0.30) removed and redistributed, because its fallback says that signal must not penalise the score. Unredistributed, the maximum is 0.70 and katana's `CRITICAL_RISK = 0.7` (`areas.mjs`) would be all but unreachable. |
| D4  | Coverage boost shape            | Proportional, added only to a file with churn or importers                                                                                                                                             | Line coverage is continuous, unlike the skill's depth tiers. A file with no other signal is not made critical by being untested alone, and its boost is what the skill describes: "low depth in a high-churn file".                                                   |
| D5  | Which files are areas           | The 25 highest candidates with a score above 0, plus any path that already declares `symbols`, which takes none of the 25                                                                              | Katana alarms on every listed area, so listing every file would turn "last coverage removed" into noise on low-risk files. A constant keeps the surface small.                                                                                                        |
| D6  | Candidate files                 | `git ls-tree -r HEAD`, JS/TS/Python/PHP sources, minus tests, fixtures, vendored and built trees, and `.d.ts`                                                                                          | `base` names HEAD, so the list must too. These are the languages canary already scans.                                                                                                                                                                                |
| D7  | Who counts as an importer       | Non-test source files only                                                                                                                                                                             | The signal is "a change here breaks more". Counting tests would rank well-tested files higher, which inverts the risk.                                                                                                                                                |
| D8  | Churn window                    | 90 days back from HEAD's commit time, not the wall clock                                                                                                                                               | The skill's window, anchored so the same commit gives the same ranking on any day. Only `generated` changes between runs.                                                                                                                                             |
| D9  | Shallow clone                   | Churn is `null` with a reason, and the score falls back to importers                                                                                                                                   | `actions/checkout` defaults to depth 1, where every file reads as one commit. That is unknown, not low.                                                                                                                                                               |
| D10 | Nothing to rank                 | Exit 3, and write nothing. Covers no git repo, no commit, no source file, and all scores 0                                                                                                             | The #508 doctrine, and the prior art in `ts/src/inventory/inventory-cli.ts`. An empty file would also overwrite a good one.                                                                                                                                           |
| D11 | Coverage report                 | `--coverage <file>`, else the first of `coverage/lcov.info`, `lcov.info`, `coverage/coverage.json`, `coverage.json`, `coverage.xml`                                                                    | Reuses `readReportIndex` and `anchorIndex` (`ts/src/guardian/diff-coverage/report-tier.ts`), so canary keeps one reader per format.                                                                                                                                   |
| D12 | Unusable report                 | Explicit `--coverage` that is missing or unparseable exits 2 and writes nothing. A discovered one, or one giving a percentage for 0 files, is absent + a reason                                        | A typo'd flag quietly degrading is the false-green shape. A stale file in `coverage/` should not stop katana getting its map.                                                                                                                                         |
| D13 | `symbols` in an existing file   | Kept, per the skill's rule. The area stays listed even below the top 25. Symbols for a path that is not a tracked file in HEAD, and a list katana's contract rejects, are dropped, and the CLI says so | The skill says "keep any `symbols` an area already declares", and a person chose them.                                                                                                                                                                                |
| D14 | `rank_score` as well            | Write it, equal to `risk_score`                                                                                                                                                                        | `ts/src/briefing/inputs.ts` reads `rank_score`, while every other consumer and the skill's schema use `risk_score`. Without it the briefing gets no ranks from this file.                                                                                             |
| D15 | Registry                        | `ts/src/commands/audit/cli.ts`                                                                                                                                                                         | `readiness` is at its cap of 12 imports. `audit` is "history-driven", which churn is, and has room, so no new domain is needed.                                                                                                                                       |
| D16 | Git root                        | `--root` resolves to the repository top level, including the default output                                                                                                                            | Consumers match repo-relative paths. A map generated from a subdirectory would hold paths nothing else agrees on.                                                                                                                                                     |
| D17 | Overwriting a skill-written map | Overwrite, keeping `symbols`                                                                                                                                                                           | The skill can regenerate its judgement, and the file is gitignored generated state. A refusal flag would add surface for no stated need. The guide states the behavior.                                                                                               |

### Approaches considered

| Approach                                        | Gain                                                               | Cost                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **A. Engine CLI (chosen)**                      | Reachable by any lane as `canary critical-areas`; prior art exists | Grows the engine's module-size aggregate                                                                                       |
| B. Skill script (`canary skills run ...`)       | Sits next to katana, and needs no engine growth                    | The issue asks for `canary critical-areas`. It would also need its own coverage readers, since skills cannot import the engine |
| C. Wrap harness `detect_anomalies`/`get_impact` | Richer signals                                                     | Not deterministic across harness versions, and absent without the MCP server, which is the case this fixes                     |

## Technical design

```text
canary critical-areas [--root <dir>] [--out <path>] [--coverage <file>]

ts/src/critical-areas/
  critical-areas-cli.ts   command, coverage read, write, exit codes
  declared-symbols.ts     symbols kept through a rewrite
  git-signals.ts          top level, HEAD, candidate files, churn, shallow check
  importers.ts            reads source files, counts unique importers
  scoring.ts              pure: normalize, score, pick areas, render the document
```

Output:

```json
{
  "generated": "2026-11-03T22:00:00.000Z",
  "base": "<full HEAD sha>",
  "generator": "canary critical-areas",
  "files_analyzed": 412,
  "signal_sources": {
    "churn": { "status": "measured", "window_days": 90 },
    "importers": { "status": "measured" },
    "coverage": {
      "status": "absent",
      "reason": "no report at coverage/lcov.info, ..."
    }
  },
  "areas": [
    {
      "path": "src/billing/charge.ts",
      "risk_score": 0.82,
      "rank_score": 0.82,
      "signals": ["high_churn", "many_dependents"],
      "recommended_test_types": ["unit", "integration"],
      "summary": "14 commits in 90 days, 9 importers, coverage not measured",
      "churn_commits": 14,
      "importers": 9,
      "coverage_pct": null
    }
  ]
}
```

- `signals` uses the skill's vocabulary. `high_churn` and `many_dependents` fire
  at half the largest value in scope or above. `low_coverage` fires under 50%.
- `recommended_test_types` is `["unit"]`, plus `"integration"` for
  `many_dependents`. It is a rule, not a judgement; the skill still makes the
  judgement when asked.
- A file a present report does not list, or lists with no denominator, is
  `coverage_pct: null`. The report did not measure it, so it is not 0%.
- A report key binds a file by exact repo-relative path after `anchorIndex`,
  never by suffix.

Importer resolution is read, not resolved, as in katana's `imports.mjs`:

| Language | Counted                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/TS    | Relative `import`, `from`, `require` and `import()`, with `.js` mapped to `.ts`, and `index.*`; `@/`, `~/`, `#/` aliases by unique path suffix |
| Python   | `import a.b` and `from a.b import c` by unique path suffix; leading dots relative to the file                                                  |
| PHP      | `require` and `include` of a string path; `use A\B\C` by unique path suffix                                                                    |

Whole-line comments are skipped. An ambiguous suffix counts nothing and a
mention in a string or docstring can count, so the count is approximate: it can
miss an aliased or ambiguous import and can count a mention in a string. The
guide says that.

Exit codes:

| Code | When                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | The file was written                                                                  |
| 1    | The file could not be written; an existing file is left intact                        |
| 2    | `--coverage` names a report that is missing or cannot be parsed                       |
| 3    | Abstained: git not found, no git repo, no commit, no source file, or every score is 0 |

## Integration points

### Entry Points

A new `canary critical-areas` sub-app, built by `buildCriticalAreasCommand`.

### Registrations Required

- `ts/src/commands/audit/cli.ts`, never `ts/src/cli.ts` (#988).
- `EXPECTED_COMMANDS` in `ts/test/cli-command-registry.test.ts`.
- An abstention row in `ts/test/gate-conformance.test.ts`.
- Each new module in both `entropy.entryPoints` and `performance.entryPoints`.

### Documentation Updates

- New `docs/guides/critical-areas.md`, with a markdown link to each new source
  file for the docs-coverage floor, and linked from `docs/guides/index.md`.
- `README.md` command table.
- `agents/skills/claude-code/canary-critical-areas/SKILL.md` names the CLI.
- `agents/skills/claude-code/canary-katana/SKILL.md` carries the new line.
- `commands/canary-critical-areas.md` names the skill.
- `AGENTS.md` gets one line at most, and only if a section already lists sibling
  producers. PRs #1537 and #1544 edit that file.

### Architectural Decisions

None warrants an ADR. This adds a producer under an existing contract.

### Knowledge Impact

`rank_score` and `risk_score` are two names for one idea across consumers (D14).
Recorded in the guide. Unifying them is a follow-up.

## Success criteria

1. When `canary critical-areas` runs in a git repository with ranked source
   files, the system shall write `.canary/critical-areas.json` and exit 0.
2. When `--out <path>` is given, the system shall write there and create missing
   parent directories.
3. When no coverage report is present, the system shall write
   `coverage_pct: null` for every area and record `coverage` as absent with a
   reason.
4. If a report is present but does not list a file, then the system shall not
   write `coverage_pct: 0` for that file.
5. When generated output is given to katana's `--critical-areas`, katana shall
   not print the degraded line, and shall alarm when a diff removes the last
   test covering a listed area.
6. When generated output is read by `parseCriticalAreas`, `loadAreas` and
   `readRankIndex`, each shall return the listed paths and scores.
7. If there is nothing to rank, then the system shall exit 3, and shall not
   create or replace the output file.
8. If the clone is shallow, then the system shall write `churn_commits: null`,
   record why, and rank on importers.
9. When the existing file declares `symbols` for a path still in HEAD, the
   system shall keep them, even for an area outside the top 25.
10. When run twice on one commit, the system shall write documents differing
    only in `generated`.
11. `commands/canary-critical-areas.md` shall not name an agent that does not
    exist under `agents/agents/claude-code/`.
12. When katana runs without usable critical-area data, its degraded line shall
    name `canary critical-areas`.

## Implementation order

1. `scoring.ts`: the pure document builder, test first.
2. `git-signals.ts` and `importers.ts`, tested against a real temporary repo.
3. `critical-areas-cli.ts` and its registry entry, with the abstention row.
4. Consumer proof: generated output through katana's CLI and three engine
   readers.
5. Katana's degraded line and the command fix.
6. Docs, entry points, and the ratchets.
