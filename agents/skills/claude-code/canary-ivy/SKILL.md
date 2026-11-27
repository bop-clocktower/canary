---
name: canary-ivy
description:
  Suite overgrowth report. Names setup bodies repeated across a suite, tests
  whose covered lines coincide, and test and file durations that grew over the
  run-history store, with where suite time went and the run where each one grew.
  Report only - it never says which test should go, ranks nothing by how needed
  it is, and is never a gate. Self-contained and deterministic.
cli: scripts/cli.mjs
requires: [node>=20]
---

# Canary Ivy

A suite that grows every month, or copies the same setup into a dozen files, has
a real cost that no single PR shows. Ivy makes that growth visible. It reports
three suite-level facts and stops there:

| Section                    | What it names                                                            |
| -------------------------- | ------------------------------------------------------------------------ |
| Duplicated fixtures        | The same setup body defined in more than one place, with every location  |
| Overlapping coverage       | Sets of tests whose covered lines are identical, with the shared lines   |
| Runtime creep over history | Where suite time went, and the run at which a test's or file's time grew |

## The invariant

Ivy is governed by
[ADR 0039](../../../../docs/knowledge/decisions/0039-canary-ivy-report-only.md).
It **reports and never recommends that a test go**:

- No output, in Markdown, JSON, stdout or stderr, tells you to take a test out
  of the suite in any form. A finding names what overlaps or what grew, never
  what should be cut.
- Nothing is ranked or scored by how needed a test is. Lists are ordered by
  size, growth or path.
- Every overlapping-coverage finding says, in the finding itself: _shared line
  coverage does not show that these tests check the same behaviour; read their
  assertions._ Line coverage records which lines ran, not what was checked, and
  one of two "identical" tests may be the only check of the behaviour that
  breaks next.
- It is never a gate. Findings never change the exit code.

A test in `agents/skills/test/canary-ivy-cli.test.ts` plants two tests with
identical coverage and different assertions, and scans every output against a
deletion-vocabulary denylist. Adding a "safe to cut" hint means superseding ADR
0039 first.

What to do with a finding is your decision. Read the assertions, the history,
and the code.

## Inputs

| Input                        | Flag              | Absent                                                                             |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| Test files (setup blocks)    | `path ...`        | the current directory                                                              |
| Per-test coverage            | `--coverage PATH` | overlap is **not assessed**, and the report says so                                |
| Run-history store (`.jsonl`) | `--history PATH`  | reads `test-results/reports/history-v2.jsonl`; if that is absent, **not assessed** |

### Per-test coverage

Ivy reads per-test coverage; it does not produce it. Two shapes are accepted:

- **coverage.py with dynamic contexts.** Record with
  `pytest --cov --cov-context=test` (or `dynamic_context = test_function`), then
  write `coverage json --show-contexts`. A coverage.py file without contexts is
  reported as not assessed, with that instruction.
- **The neutral map**, for any other producer:

  ```json
  {
    "schema_version": 1,
    "tests": {
      "tests/test_cart.py::test_total_sums_items": {
        "src/cart.py": [3, 4, 5, 9]
      }
    }
  }
  ```

Tests are grouped only when their covered `(file, line)` sets are exactly equal.
A test whose lines are a subset of another's is never reported: "covers nothing
the other does not" is not a fact about what either test checks.

### Run history

Ivy reads `timestamp`, `commit_sha` and `run_id` per run, and `test_file`,
`test_name` and `duration_ms` per test, from the store `canary history record`
writes ([schema](../../../../ts/src/history/schema.ts)). It writes nothing to
the store. Runs are ordered by `timestamp`, not file order.

## What each section reports

**Duplicated fixtures.** pytest `@pytest.fixture` functions and unittest `setUp`
/ `setup_method` (by indentation), JS/TS `beforeEach` / `beforeAll` and PHP
`setUp` / `set_up` (by brace depth). Two blocks match when their bodies are
equal after comments and blank lines are dropped and whitespace is collapsed. A
body under two lines is not reported: a one-line `vi.restoreAllMocks()` is
idiom, not overgrowth. This is a suite-level fact `/canary-review-test` cannot
see from one file; whether one fixture's scope is right stays that reviewer's
question.

**Overlapping coverage.** Each group lists its tests, the line count, the shared
lines as ranges per file, and the caveat.

**Runtime creep.** For each test and each file (summed per run), the split of
its series that maximizes the gap between the mean before and after is where it
grew. A series is listed when it has at least 6 runs, its median after the split
is at least 1.5x its median before, and the gap is at least 100 ms. Those are
listing rules, printed with the report. "Where the time went" lists the 10 files
with the largest median over their last 5 runs, with each one's share.

This is not `canary-ci-ready`'s runtime check: ivy gives no readiness verdict,
no pass/warn/fail grade and no p95, and never writes perf baselines. ci-ready
answers "is the runtime acceptable now"; ivy answers "where did the time go, and
when did it grow".

## Invocation

```bash
# Setup blocks under tests/, plus the default history store:
canary skills run canary-ivy -- tests

# All three sections:
canary skills run canary-ivy -- tests \
  --coverage coverage.json \
  --history test-results/reports/history-v2.jsonl

# Machine-readable, and kept as an artifact:
canary skills run canary-ivy -- tests --json --out test-results/reports/ivy.json

# Usage and flags (exits 0):
canary skills run canary-ivy -- --help
```

`--out PATH` writes the same text printed to stdout, creating parent
directories. If it cannot be written, ivy prints
`canary-ivy: cannot write artifact: <reason>` and exits 1.

### Exit codes

| Code | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | The report was printed and at least one section was assessed, whatever it found                     |
| `1`  | I/O only: a named path, `--coverage` or `--history` could not be read; `--out` could not be written |
| `2`  | Usage error                                                                                         |
| `3`  | Abstained: no section had input to read. Never a clean report                                       |

There is no `--strict`. A section with no input is printed as
`not assessed: <reason>`, never left out, and when all three are, the report
opens with `⚠ Abstained — verified zero items; this is not a pass.`

## JSON shape

`schema_version: 1`, `tool`, `abstained`, and `sections.fixtures`,
`sections.coverage`, `sections.runtime`. Each section has `status` (`assessed`
or `not_assessed`), `denominator`, and `reason` when not assessed. Assessed
sections carry `groups` (fixtures, coverage), `not_read` (fixtures), `caveat`
(coverage, on the section and on every group), and `thresholds`,
`where_time_went` and `creep` (runtime). A creep row has `scope` (`test` or
`file`), `file`, `test`, `before_median_ms`, `after_median_ms`, `gap_ms`,
`observations` and `grew_at` (`timestamp`, `commit_sha`, `run_id`).

## Hostile input

Test names, paths, fixture bodies, coverage keys and history fields are text a
branch controls. Every one passes through one helper (`scripts/text.mjs`) before
it is printed: ANSI and other escape sequences are stripped, newlines, control
and bidi characters become a space, length is clamped (160 code points, 400 for
reasons and line ranges), and Markdown metacharacters are escaped in Markdown
output. A value cannot add a report line, forge a link or table cell, or move
the terminal cursor.

The fixture scan is bounded: a block longer than 400 lines is abandoned, a
fixture decorator looks at most 20 lines ahead for its def, and a test file over
1,000,000 bytes or 20,000 lines is not parsed. Such a file is listed under "Not
read" with the reason, and counted in `files_not_read`.

## Fidelity limits

- **Line scan, not a parser.** Brace counting does not lex strings, so a `{` in
  a string literal can move a JS or PHP block's end. A pytest def whose
  signature spans lines has its continuation lines read as body.
- **Body identity is exact after normalization.** Two setups that differ by a
  variable name are not grouped.
- **Coverage overlap is as good as its producer.** A coverage.py run without
  dynamic contexts has no per-test data, and is reported as not assessed.
- **Runtime creep needs history.** A test with fewer than 6 timed runs is
  counted in the denominator and never listed.
