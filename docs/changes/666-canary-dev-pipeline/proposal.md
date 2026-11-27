# canary-dev-pipeline — advisory dev-time test guidance for the working diff

**Issue:** #666 · **Route:** feature · **Status:** proposed (autonomous lane,
roadmap-fleet run 2026-11-27)

**Keywords:** dev-pipeline, working-diff, advisory, edge-cases, gap-analysis,
coverage-ties, critical-areas, abstention, time-budget

## Overview

Canary has two pipelines and neither fits the middle of a change.
`canary-test-pipeline` is validation-shaped: it loops critical-areas, edge
cases, failure impact, write-test and ci-ready until the suite is CI-ready
(`agents/skills/claude-code/canary-test-pipeline/SKILL.md`, Phases 0-5).
`canary-pr-guardian` is gate-shaped: it scores a finished diff and blocks once.
At 10am with a half-written feature open, both are too heavy, so in practice
nothing runs.

`canary-dev-pipeline` is one command for that moment. With no arguments it reads
the working diff, runs the cheap deterministic members over it, and prints an
advisory brief: what the change puts at risk, which changed source files no test
ties to, which changed tests carry isolation or temporal smells, and which agent
skill to run next on what. It never gates, never runs the suite, and stays
inside a stated time budget.

## Goals

1. One zero-argument invocation answers "what should I think about testing for
   the work in front of me" in seconds.
2. Compose existing skills. No new analysis engine.
3. Advisory always: findings never change the exit code.
4. Abstain loudly (exit 3) when there is nothing to analyse, instead of reading
   as all clear.
5. Hand off to the agent-layer skills (edge cases, failure impact) and to test
   generation the same human-confirmed way `canary-test-pipeline` does.

## Non-goals

- Not a replacement for `canary-test-pipeline` (suite readiness) or
  `canary-pr-guardian` (the gate). Anything that can block belongs in the
  guardian.
- Not a test runner. It executes no test and no suite.
- Not a coverage tool. "Tied" means a test file is linked to the source file by
  katana's tie rules, not that a line was executed.
- Not a writer. It writes nothing unless `--out` is given; in particular it does
  not regenerate `.canary/critical-areas.json`.
- No new slash command, Gemini command or `ts/src` engine code (see D8).

## The five design questions

### Q1 — Membership

| Candidate                                              | In?                                  | Why                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canary-critical-areas`                                | **yes** (as a map reader)            | Its deterministic half is `canary critical-areas`, which writes `.canary/critical-areas.json` (`ts/src/critical-areas/critical-areas-cli.ts:1-11`). The pipeline reads that map through katana's validated loader (`canary-katana/scripts/areas.mjs:57`) and intersects it with the diff. It never regenerates it: that is a whole-repo walk and a write. |
| coverage ties (from `canary-katana`)                   | **yes**                              | Katana already decides whether a test file "covers" a path (`canary-katana/scripts/ties.mjs:25`, over the test index from `testindex.mjs:139` and the context from `areas.mjs:231`). Reused verbatim, so "tied" means one thing across both skills.                                                                                                       |
| `canary-savant` (static)                               | **yes**                              | `scanPaths` (`canary-savant/scripts/scanner.mjs:455`) is deterministic, file-scoped and fast. Isolation smells are cheapest to fix while the test is still being written. The `--confirm` pass runs the suite and is excluded.                                                                                                                            |
| `canary-blackhawk`                                     | **yes**                              | Same shape (`canary-blackhawk/scripts/scanner.mjs:265`). A wall-clock dependence is easiest to remove before it lands.                                                                                                                                                                                                                                    |
| `canary-edge-case-discovery`                           | **yes** (agent layer)                | LLM skill. The script names the top targets; the SKILL.md tells the agent to run it on them (`/canary-edge-cases <path>`).                                                                                                                                                                                                                                |
| `canary-failure-impact`                                | **yes** (agent layer, gated by risk) | LLM skill. Suggested only for changed files with `risk_score >= 0.7`, the threshold katana already uses for "critical" (`areas.mjs:24`).                                                                                                                                                                                                                  |
| `canary-cassandra`                                     | no                                   | Suite-audit shaped, and it delegates to `ts/dist`, so it is not self-contained in a dev loop.                                                                                                                                                                                                                                                             |
| `canary-ci-ready`, `canary-ship`, `canary-pr-guardian` | no                                   | Readiness, shipping and gating. Out by definition (Q4).                                                                                                                                                                                                                                                                                                   |
| `canary-clocktower`                                    | no                                   | See Q2.                                                                                                                                                                                                                                                                                                                                                   |

### Q2 — Is "gap analysis" an existing skill or a new one?

It is a **composition of existing ones**, so no new engine is built.

- `canary-clocktower` is run-history gap analysis: which history-store consumers
  are fed by which fields (`canary-clocktower/SKILL.md:1-14`). It is about the
  store, not about the code being written. Not a dev-time member.
- `canary-critical-areas` ranks risk but says nothing about whether a changed
  file is tested.
- Katana's tie predicate answers exactly "does any test file cover this path",
  and it is already exported and already reused across skills
  (`canary-unquarantine` imports katana modules, e.g.
  `canary-unquarantine/scripts/scan.mjs:11`).

Dev-time gap analysis = **changed source files** × **katana ties** (is any test
tied?) × **critical-areas risk** (how much does an untied one matter?). Every
factor exists. The only new code is target resolution, the budget loop and
rendering.

### Q3 — Trigger and cost

- **Default target: the working diff** (maintainer decision). That is tracked
  changes against the merge base of `HEAD` with the default branch, plus
  untracked, non-ignored files. Deleted files are counted and not analysed;
  katana owns deletions.
- **Explicit paths override it.** An open file or a named target is just a path
  argument (`canary skills run canary-dev-pipeline -- src/cart.ts`).
- **Time budget: 5000 ms** for the deterministic pass (`--budget-ms` overrides).
  Members run cheapest-first and the budget is checked before each member; a
  member that would start after the budget is reported as
  `not run: time budget spent` and the brief still renders. Each git call has
  its own 10 s timeout. No member executes a test.
- **Size clamp:** at most 200 target files are analysed; the rest are counted as
  clamped. Markdown lists at most 25 rows per section (JSON carries every row).

### Q4 — Advisory, always

| Outcome                                  | Exit |
| ---------------------------------------- | ---- |
| Brief rendered, with or without findings | 0    |
| Cannot write the `--out` file            | 1    |
| Usage error                              | 2    |
| Abstained: nothing analysed              | 3    |

Exit 1 is never a finding; it is the sibling skills' "cannot write" convention
(`canary-question/scripts/cli.mjs:72`). There is no `--strict`. Blocking belongs
in `canary-pr-guardian`.

### Q5 — Overlap with #607

Issue #607 is the spine, and it already shipped: `canary-test-pipeline` Phase 4
includes edge cases as test variants and asks before each `canary-write-test`
(`canary-test-pipeline/SKILL.md:84-87`; #607 was closed as already shipped on
that evidence). The dev pipeline reuses the same human-confirmed pass-through:
its brief suggests `/canary-edge-cases` on the top targets, and the SKILL.md
says to confirm with the user before any `/canary-write-test`. No new handoff
artifact and no automatic pipe.

## Decisions made

| ID  | Decision                                                                                                                                                                                                            | Source                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| D1  | Default target is the working diff; explicit path arguments override it; zero arguments must work.                                                                                                                  | Maintainer                                  |
| D2  | Advisory: findings never produce a non-zero exit. Nothing analysed abstains with exit 3 and the `ABSTAINED_LINE` wording, on stdout and stderr.                                                                     | Maintainer, ADR 0009                        |
| D3  | Deterministic members run in process by importing the sibling skills' exported functions, not by spawning their CLIs.                                                                                               | Lane (recommended option)                   |
| D4  | Time budget 5000 ms, checked between members; size clamp 200 files, 25 Markdown rows per section.                                                                                                                   | Lane (maintainer asked for a stated budget) |
| D5  | Default branch: `origin/HEAD`'s target, else the first of `origin/main`, `main`, `origin/master`, `master` that resolves. None resolving means the target is uncommitted changes against `HEAD`, said in the brief. | Lane                                        |
| D6  | Every value from git, the diff, file paths or member output goes through one escaping module before Markdown, stdout or stderr.                                                                                     | Maintainer (security)                       |
| D7  | The registry row for this skill asserts exit 3 on abstention by default, since there is no `--strict`.                                                                                                              | Lane, follows from D2                       |
| D8  | A script skill under `agents/skills/`, no `ts/src` code: `.mjs` is outside the arch module-size aggregate, which has about 26 lines of headroom.                                                                    | Maintainer (ratchets)                       |
| D9  | Name `canary-dev-pipeline`, following the current `canary-*` folder convention (a repo-wide prefix drop is #1773).                                                                                                  | Maintainer                                  |

**ADR 0009 tension, recorded rather than resolved here.** ADR 0009 says advisory
commands warn and exit 0 on abstention, and only gates exit 3. The maintainer
chose exit 3 for this advisory skill. The precedent is `canary history gaps`
(`canary-clocktower/SKILL.md:10`), which is read-only and also exits 3 when it
abstains. Exit 3 means "verified zero items" and nothing else, which stays true.

## Approaches considered

| Approach | A) Script skill composing in process (**chosen**)                                                                                    | B) Prompt-only SKILL.md orchestrator                                             | C) Engine command in `ts/src`                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| How      | `scripts/cli.mjs` resolves the target, imports katana/savant/blackhawk functions, renders a brief; the SKILL.md adds the agent layer | Like `canary-test-pipeline`: the agent runs each skill by hand                   | `canary dev` subcommand in the engine                                    |
| Pros     | Deterministic, testable, fast, one command                                                                                           | Zero code                                                                        | Shares engine helpers (`gateOutcome`)                                    |
| Cons     | Depends on sibling skills' exports                                                                                                   | Slow and non-deterministic; it is the "too heavy, so nothing runs" problem again | Blows the arch module-size headroom; engine cannot import skill scanners |
| Risk     | A sibling export renames (caught by this skill's tests)                                                                              | No abstention contract at all                                                    | Ratchet park                                                             |

## Technical design

### Layout — `agents/skills/claude-code/canary-dev-pipeline/`

| File                  | Role                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`            | Frontmatter `cli: scripts/cli.mjs`, `requires: [node>=20]`; usage, members, boundary, agent-layer steps                                     |
| `scripts/cli.mjs`     | `CLI_SPEC`, `main(argv, deps)`, budget loop, exit codes, `--out`                                                                            |
| `scripts/escape.mjs`  | `clean` (strip ANSI, control and newline characters; clamp length), `md` (clean, then escape Markdown metacharacters), `cleanDeep` for JSON |
| `scripts/target.mjs`  | Working-diff and explicit-path resolution; git through `execFileSync` argv only                                                             |
| `scripts/members.mjs` | The four deterministic members: risk, isolation, temporal, ties                                                                             |
| `scripts/render.mjs`  | Markdown and JSON briefs, suggestions                                                                                                       |

### CLI

```text
canary skills run canary-dev-pipeline -- [path ...] [--repo DIR] [--json]
                                          [--out PATH] [--budget-ms N]
```

### Brief shape (JSON, `schema_version: 1`)

```json
{
  "schema_version": 1,
  "advisory": true,
  "abstained": false,
  "reason": null,
  "target": {
    "mode": "diff",
    "base": "abc1234",
    "base_ref": "origin/main",
    "files": 3,
    "source": 1,
    "test": 1,
    "other": 1,
    "deleted": 0,
    "clamped": 0,
    "notes": []
  },
  "members": [
    {
      "name": "risk",
      "skill": "canary-critical-areas",
      "status": "ran",
      "checked": 1,
      "reason": null,
      "rows": []
    }
  ],
  "suggestions": ["/canary-edge-cases src/cart.ts"],
  "budget_ms": 5000,
  "elapsed_ms": 41
}
```

`status` is `ran`, `not-checked` (with a reason, e.g. no map), `budget` (not
run: time budget spent) or `error` (the member threw; its message is reported
and the run continues). The run abstains when the target is empty, or when the
members checked zero items between them.

### Security

- One escaping module (`escape.mjs`) for every dynamic value. Markdown values go
  through `md`; stderr lines through `clean`; JSON strings through `cleanDeep`.
- Git is called with `execFileSync('git', ['-C', repo, ...])`, never a shell.
  Revisions are followed by `--end-of-options`. `GIT_DIR`, `GIT_WORK_TREE` and
  `GIT_INDEX_FILE` are removed from the child environment, so `--repo` decides
  the repository.
- File lists are read with `-z`, so a newline in a file name cannot split or
  forge a row.
- No regular expression is built from input text. If one is ever needed, it is
  built with the module's `escapeRegExp`. A test checks that the scripts contain
  no `new RegExp(` outside that helper.
- `--out` failures print `cannot write artifact: <reason>` and exit 1, with no
  stack trace.

## Integration points

### Entry Points

- New skill `canary-dev-pipeline`, run through
  `canary skills run canary-dev-pipeline`, and listed in the plugin as
  `canary:canary-dev-pipeline`.

### Registrations Required

- `.claude-plugin/plugin.json` `skills`.
- `docs/naming-registry.md` row (`shipped`, issue 666).
- `harness.config.json`: `scripts/cli.mjs` in both `entropy.entryPoints` and
  `performance.entryPoints`. This is the only config edit.
- `agents/skills/package.json` `format:check` glob, and the per-skill coverage
  include in `agents/skills/vitest.config.ts`.
- A row in the skill gate-conformance registry
  (`agents/skills/test/gate-conformance.test.ts`).

### Documentation Updates

- `agents/skills/README.md` (tree, count, and an entry in the list).
- The SKILL.md links from `canary-test-pipeline` and `canary-pr-guardian`, which
  state the boundary.
- `CHANGELOG.md` `[Unreleased]` → `### Added`.
- `docs/roadmap.md` row for #666: spec link.

### Architectural Decisions

None warrants a standalone ADR. The exit-3-for-advisory tension (D2) is a
precedent already set by `canary history gaps`, so it is recorded here.

### Knowledge Impact

- The concept "dev-time gap = untied changed source × risk", composed from
  katana ties and the critical-areas map.

## Success criteria

1. When run with no arguments in a repository with a non-empty working diff, the
   skill renders a brief covering every changed source and test file, and
   exits 0.
2. When the working diff is empty, or the directory is not a git repository and
   no path is given, it prints the abstained line and a reason on stdout and
   stderr, and exits 3. It never prints an all-clear.
3. When explicit paths are given, the working diff is not read.
4. A changed source file that no test ties to is reported as a gap. One that a
   test imports is reported as tied, with that test named.
5. Savant and blackhawk findings on changed test files appear with file, line
   and rule.
6. If `.canary/critical-areas.json` is absent, the risk member is `not-checked`
   with the command that creates it.
7. On a 200-file fixture diff, the run finishes inside the 5000 ms budget. With
   an exhausted budget, remaining members report `budget` and the run still
   renders.
8. Findings never produce a non-zero exit; `--out` to an unwritable path exits 1
   with `cannot write artifact`.
9. A file name with a newline, ANSI escapes or Markdown metacharacters renders
   as one escaped, clamped row. A repository path containing shell
   metacharacters is used as a literal path.
10. Every gate in `ts/` and `agents/skills/` passes, and perf, arch and entropy
    do not grow against the base.

## Implementation order

1. Escaping module and its tests.
2. Target resolution (diff and explicit paths) and its tests.
3. Members and the budget loop.
4. Rendering, CLI, exit codes and `--out`.
5. Registration, docs, the conformance row and the ratchet measurements.

## Assumptions (autonomous lane)

- No human was available. Every EVALUATE question was answered with the
  maintainer's decisions or the recommended option (D3-D7), and none was put to
  a human.
- The katana, savant and blackhawk exports used here are a stable enough
  surface. `canary-unquarantine` already imports katana modules the same way.
