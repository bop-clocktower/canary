---
name: canary-dev-pipeline
description:
  Advisory dev-time test guidance for the work in front of you. With no
  arguments it reads the working diff (changes against the merge base with the
  default branch, plus untracked files), runs the cheap deterministic members
  over it inside a 5-second budget -- critical-areas risk, katana test ties
  (which changed source files no test ties to), canary-savant isolation smells
  and canary-blackhawk temporal smells on changed tests -- and names which agent
  skill to run next on what. Use mid-change when asking "what am I going to miss
  here" or "what should I test for this". Findings never change the exit code;
  nothing to analyse exits 3 (abstained). NOT a gate (canary-pr-guardian is),
  NOT suite readiness (canary-test-pipeline is), and NOT a test runner.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Dev Pipeline

`canary-test-pipeline` asks "is this suite good enough to ship?" and
`canary-pr-guardian` asks "may this diff merge?". Neither fits the middle of a
half-written feature, where the useful questions are "what am I going to miss",
"what is already covered" and "what is risky about this shape". Both pipelines
are too heavy for that moment, so in practice nothing gets run. This one is
built to be cheap enough to run anyway.

It composes existing skills and adds no analysis engine. See
[the spec](../../../../docs/changes/666-canary-dev-pipeline/proposal.md) for the
reasoning behind its membership.

## Usage

```bash
canary skills run canary-dev-pipeline -- --help
```

<!-- canary:illustrative -->

```bash
canary skills run canary-dev-pipeline                 # the working diff
canary skills run canary-dev-pipeline -- src/cart.ts  # a named file or directory
canary skills run canary-dev-pipeline -- --json --out brief.json
```

| Flag            | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| `path ...`      | Analyse these files or directories instead of the working diff.  |
| `--repo DIR`    | Repository to read (default: the current directory).             |
| `--json`        | Print the brief as JSON (`schema_version: 1`).                   |
| `--out PATH`    | Also write the brief to PATH. A write failure exits 1.           |
| `--budget-ms N` | Time budget for the whole run, in milliseconds (default `5000`). |

**The working diff** is tracked changes against the merge base of `HEAD` with
the default branch, plus untracked files that are not ignored. The default
branch is `origin/HEAD`'s target, or else the first of `origin/main`, `main`,
`origin/master` and `master` that exists. When none of those exists, the target
is uncommitted changes only, and the brief says so. Deleted files are counted
but not analysed, because canary-katana owns deletions. At most 200 files are
analysed; any more are counted as clamped.

## Members

They run in this order, cheapest first. The budget is checked before each one.

| Section                  | Composes                                                                                              | Reads          |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------- |
| Risk                     | the `.canary/critical-areas.json` map from `canary critical-areas`, through katana's validated loader | changed source |
| Isolation smells         | `canary-savant` static scan (never `--confirm`)                                                       | changed tests  |
| Temporal dependence      | `canary-blackhawk` scan                                                                               | changed tests  |
| Test ties (gap analysis) | katana's tie rules: which test files cover a path                                                     | changed source |

- **Risk** is `not-checked` when there is no map. It never regenerates the map,
  because that walks the whole repository and writes a file. Run
  `canary critical-areas` when you want it.
- **Test ties** is the gap analysis. A changed source file that no test ties to
  is a gap, and an untied file with high risk is the first thing to look at.
  "Tied" uses the same rules as katana grading a deletion. It means a test file
  imports, sits beside, or names the file. It does not mean the lines ran.
- A member that would start after the budget is spent is reported as
  `Not run: time budget spent`, and the brief still renders. A member that fails
  is reported as `Error` and the others still run.

No member executes a test.

## Exit codes

| Code | Meaning                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | A brief was rendered. Findings never change this.                                                                                       |
| 1    | `--out` could not be written (`cannot write artifact: ...`).                                                                            |
| 2    | Usage error.                                                                                                                            |
| 3    | Abstained: empty working diff, not a git repository (with no path given), paths that select nothing, or no member could check any file. |

An abstention prints the family's abstained line and its reason on stdout and
stderr. It is never an all-clear.

## The agent layer

The script is the deterministic half. When an agent runs this skill:

1. Run the CLI. Read the brief. If it abstained, say why and stop.
2. Take `## Suggested next` in order. For each `/canary-edge-cases <path>`, run
   `canary-edge-case-discovery` on that file, gaps first. Run
   `/canary-failure-impact <path>` only where it is suggested, which is for
   files with `risk_score >= 0.7`.
3. Present what was found. **Ask before generating anything.** Run
   `/canary-write-test` only for the cases the user confirms. This is the same
   human-confirmed handoff `canary-test-pipeline` Phase 4 uses (#607): no
   automatic pipe from discovery to generation.
4. Stop there. Do not loop, do not run the suite, and do not report a verdict.

## Boundaries

- **Not a gate.** It has no `--strict`. Anything that should block belongs in
  [`canary-pr-guardian`](../canary-pr-guardian/SKILL.md).
- **Not suite readiness.** For "bring this suite to CI-ready", use
  [`canary-test-pipeline`](../canary-test-pipeline/SKILL.md).
- **Not a coverage tool.** A tie is a link between files, not a measurement.

## Output safety

Every value taken from git, a file name or a member's finding passes through
`scripts/escape.mjs` before it is printed. ANSI and control characters are
stripped, newlines are flattened, the length is clamped, and Markdown
metacharacters are escaped. A file name cannot forge a row, a heading or a link.
Git runs with an argv array, never a shell, and with `GIT_DIR` removed from its
environment, so `--repo` decides the repository.
