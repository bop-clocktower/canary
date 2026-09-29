---
name: canary-question
description:
  Evidence brief for one failing test. Reads the run-history store (and,
  optionally, a git diff of the culprit range and one Tier-0 detector --json
  envelope) and lists, for three hypotheses in a fixed order -- defect in the
  test, defect in the system under test, environment -- the evidence for and
  against each, how much evidence there was, what could not be read, and what
  would help tell them apart. It is built not to pick one. Advisory; exit 0 for
  every brief.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Question

Every red build asks: is this a defect in the test or in the product? A wrong
answer is worse than none. "Just a flaky test" stamped on a real product defect
is how defects escape. So `canary-question` does not answer. It lays out the
evidence canary already has, labels how much there was, and says what
observation would help tell the hypotheses apart.

## What this is not

- **Not a classifier.** It is built not to print a verdict, disposition, score,
  ranking or lean: a test asserts that a list of verdict phrases and keys is
  absent from the markdown and JSON output of the 14 fixtures. The three
  hypotheses always appear in the same order, whatever the evidence says. This
  is a permanent contract, decided on #613, not a default a flag will later
  relax.
- **Not a gate.** There is no `--strict`. It exits 0 for every brief it
  produces, abstentions included.
- **Not a detector runner.** It reads one detector's `--json` output if you give
  it one (`canary-savant`, `canary-blackhawk`, `canary-cassandra`,
  `canary-katana`). It never runs them, re-runs the test, or calls a model.

## Invocation

```bash
# Usage and the full flag list (exits 0):
canary skills run canary-question -- --help
```

<!-- canary:illustrative -->

```bash
# Brief for one test, from the default store, diffed in this repo:
canary skills run canary-question -- --test "checkout adds the item"

# With a detector envelope and machine-readable output written to disk:
canary skills run canary-savant -- tests --json > savant.json
canary skills run canary-question -- --test "checkout adds the item" \
  --suite unit --findings savant.json --json --out reports/question.json
```

| Flag         | Default                                 | Meaning                                                     |
| ------------ | --------------------------------------- | ----------------------------------------------------------- |
| `--test`     | required                                | exact `test_name` in the store                              |
| `--suite`    | —                                       | pick one suite when the name occurs in several              |
| `--history`  | `test-results/reports/history-v2.jsonl` | run-history store; default missing = Not checked, named = 1 |
| `--findings` | —                                       | one Tier-0 detector `--json` envelope; named missing = 1    |
| `--repo`     | `.`                                     | git working tree for the culprit-range diff                 |
| `--json`     | off                                     | print the brief as JSON instead of markdown                 |
| `--out`      | —                                       | also write what was printed to this file                    |

## What it reads

The **target failure** is the test's most recent `failed` or `flaky`
observation. The **culprit range** runs from the last passing observation before
it to the target's commit.

| Signal              | Fires when                                                  | For                  | Against     |
| ------------------- | ----------------------------------------------------------- | -------------------- | ----------- |
| `same-commit-mixed` | one commit has both a pass and a failure of the test        | all three            | —           |
| `retry-pass`        | a `flaky` observation, or a pass that needed a retry        | all three            | —           |
| `regression-shape`  | a pass, then ≥2 `failed` on distinct commits, no pass since | test, product        | —           |
| `diff-test-only`    | the culprit range changed only test paths                   | test                 | —           |
| `diff-sut-only`     | the culprit range changed only non-test paths               | product              | —           |
| `diff-both`         | both changed                                                | test, product        | —           |
| `diff-none`         | the culprit range changed nothing                           | environment          | —           |
| `category-env`      | failure category `timeout` or `auth`                        | environment, product | —           |
| `category-env`      | failure category `network`                                  | environment          | —           |
| `category-server`   | failure category `server` (5xx; 502/503 are infrastructure) | product, environment | —           |
| `category-neutral`  | any other category -- recorded as not discriminating        | —                    | —           |
| `co-failure`        | other failures in the target run share its area or category | product, environment | —           |
| `isolated`          | the only failure in a run of ≥2 tests                       | test, product        | environment |
| `detector-finding`  | findings on the test's own file, one row for all of them    | test                 | —           |

Recorded as not discriminating (no side): `single-test-run` (the run held only
this test, or its size is unrecorded, so isolation cannot be observed) and
`unrelated-co-failures` (other failures in the run, none sharing its area or
category).

A one-sided signal is not listed **against** the other side when that side can
produce it too: a changed test can expose a defect the product already had, an
intended product change can leave a test's expectation stale, and a shared test
helper or fixture fails many tests at once. The row's detail says so.

Nondeterminism supports **all three** on purpose. A race in the product looks
exactly like a flaky test from the outside.

## Honest degradation

- **Fidelity** is derived, never asserted: `abstained`, `thin` (fewer than 3
  observations; a `THIN EVIDENCE` banner is printed), `history`, or
  `history+diff` (a git diff of the culprit range was actually read). The
  denominator (observations, failures, runs in store) is always printed.
- **ABSTAINED** when the store has no observation of the test, when none of its
  observations failed, or when the name occurs in several suites and no
  `--suite` was given. An abstained brief prints no evidence at all, only what
  would help.
- **Not checked** lists every source that could not be read, with the reason: a
  missing default store, skipped observations, a target with no failure
  category, no culprit range (no prior pass, or pass and failure at one commit),
  a last pass that is not an ancestor of the target, a range git could not diff
  (10s timeout), no findings file. An abstained brief lists the diff and any
  findings file as not read.

## Exit codes

`0` every produced brief, abstentions included · `1` a named `--history` or
`--findings` is missing or malformed, or `--out` could not be written · `2`
usage.
