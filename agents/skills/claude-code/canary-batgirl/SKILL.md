---
name: canary-batgirl
description:
  Team quality scorecard built only from evidence that is expensive to fake. Six
  dimensions, each read from an artifact another canary tool already writes -
  escaped-defect ratio, coverage-verified share of changed units, closure
  exercise share (batwoman), unexplained switch-offs (katana ledger), vacuous
  tests (cassandra) and red mainline commits (run history). Every one was
  admitted because adding green or assertion-free tests cannot raise it.
  Team-level only - no per-person score, rank, streak or badge - with no
  composite score. Report only, never a gate. Self-contained and deterministic.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Batgirl

A quality scorecard is a target, and a target gets optimised. The cheapest way
to raise almost any coverage-derived number is to add tests that assert nothing,
which is the exact problem canary exists to catch. So batgirl scores only what a
team cannot move that way, and the spec lists every signal it rejected next to
the cheapest way to game it
([`docs/changes/619-canary-batgirl/proposal.md`](../../../../docs/changes/619-canary-batgirl/proposal.md)).

## The rules

- **Team-level only.** It scores a repository. Nothing is per person, nothing is
  grouped by commit author, and the ledger's `author` field is never read.
- **No composite.** Each dimension stands alone with its own direction. An
  average would rise whenever a bad dimension's input was withheld.
- **Counts where a denominator is cheap to pad.** A share over tests, ledger
  rows or commits is diluted by adding more green ones; a count is not.
- **Not assessed is not zero.** A dimension with no backing data prints
  `not assessed` with the reason, and its JSON `value` is `null`.
- **Never a gate.** Values never change the exit code.

A test in `agents/skills/test/canary-batgirl-goodhart.test.ts` plants a change
that adds 200 assertion-free and 50 vacuous passing tests and asserts that no
dimension improves.

## Dimensions

| Dimension               | Better | Reads                                                      |
| ----------------------- | ------ | ---------------------------------------------------------- |
| Escaped-defect ratio    | lower  | `.canary/escapes.json` (`escapes` and `caught` arrays)     |
| Coverage-verified share | higher | guardian records in `.harness/analyses/`                   |
| Closure exercise share  | higher | `canary batwoman --json` reports, one per issue            |
| Unexplained switch-offs | lower  | katana ledger, `.canary/quarantine.json`                   |
| Vacuous tests           | lower  | a `canary-cassandra --json` report                         |
| Red mainline commits    | lower  | run-history store, `test-results/reports/history-v2.jsonl` |

The escape log is manhunter's, plus one array: `caught`, the defects found
before release, in the same `{id, summary, found_at}` shape as an escape.
Without it the ratio has no denominator and the dimension is not assessed.

## Usage

```bash
canary skills run canary-batgirl -- --help
```

```bash
canary skills run canary-batgirl --                      # conventional paths
canary skills run canary-batgirl -- --cassandra vac.json --batwoman audits/
canary skills run canary-batgirl -- --json --out reports/scorecard.json
```

| Flag               | Default                                 |
| ------------------ | --------------------------------------- |
| `--escapes PATH`   | `.canary/escapes.json`                  |
| `--guardian PATH`  | `.harness/analyses`                     |
| `--batwoman PATH`  | none (a report file, or a directory)    |
| `--ledger PATH`    | `.canary/quarantine.json`               |
| `--cassandra PATH` | none                                    |
| `--history PATH`   | `test-results/reports/history-v2.jsonl` |
| `--branch NAME`    | `main`                                  |
| `--json`           | Markdown                                |
| `--out PATH`       | stdout only                             |

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | at least one dimension assessed, whatever the values                 |
| `3`  | no dimension assessed: abstained (ADR 0009)                          |
| `1`  | a named input that cannot be read, or `--out` that cannot be written |
| `2`  | usage                                                                |

## Safety

Every path is read inside the working directory, and no symlink is followed, in
the named path or in a directory being listed. Inputs are bounded (32 MiB per
file, 100 000 entries, 200 000 history lines, 500 files per directory); an input
over a limit is reported as not read, never partly scored. Parse errors name the
error and position and quote no file content. Every value from an input is
stripped of control characters and escaped for Markdown, with autolinks
defanged.
