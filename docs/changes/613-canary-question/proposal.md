# canary-question: test-defect vs product-defect evidence brief (#613)

**Keywords:** triage, false-fail, test defect, product defect, run-history,
nondeterminism, fidelity, abstention, evidence-not-verdict, skill

## Overview

Issue #613 (ideation rank 8,
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`) asks the question every
red build raises: is this failure a defect in the test or a defect in the system
under test? It serves STRATEGY.md's test-intelligence track (`STRATEGY.md`,
Tracks).

The ideation's strongest objection is the design constraint, and it is
non-negotiable here: **a wrong triage is worse than no triage.** "It's just a
flaky test" stamped on a genuine product bug is exactly how defects escape, and
it would degrade the escaped-defect headline metric while appearing to help.

So `canary-question` does not classify. For one failing test it assembles the
evidence canary **already persists** into a brief that lists, for each
hypothesis, the evidence for it and the evidence against it, labels how much
evidence there was (fidelity + denominator), names the evidence it could not
read, and says what observation would help tell them apart. It never prints a
verdict, a disposition, a ranking, or a lean.

The issue thread (comment 1) positions it after harness-diagnostics: that skill
classifies _what kind_ of error occurred; nothing upstream asks _whose defect_
it is. It also proposes consuming the deterministic detectors canary already
ships (`canary-savant`, `canary-blackhawk`, `canary-cassandra`) as evidence
rather than judgement. The MVP takes that route.

### Out of scope (non-goals / follow-ups)

- **Any verdict, disposition, ranking, score or lean.** Whether the tool may
  _ever_ print a lean toward one side is a product fork that changes what the
  tool claims; it is **parked** for a human (follow-up F1), not guessed.
- Quarantining, retrying, editing, or skipping tests; failing a job. Advisory
  only — there is no `--strict`.
- An LLM step. The MVP is fully deterministic. If one is added later it must be
  opt-in and every sentence it contributes labelled as model output (F2).
- Consuming a harness-diagnostics category as an input signal (F3).
- Running detectors itself (it reads their `--json` output; F4), running tests,
  or re-running the failure to measure a flip rate (F5 — `canary-rewind`
  territory).
- Triage of more than one test per invocation, or of a whole run (F6).
- New engine code under `ts/src/history` (at its 1800-LOC ceiling, #1074).

## Decisions made

Autonomous fleet lane: each EVALUATE question was answered with the recommended
default and is recorded as an assumption in `provenance.json`.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                 | Rationale                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Output is an **evidence brief**, never a verdict: three hypotheses in a **fixed order** (test defect, product defect, environment), each with `for` and `against` evidence lists. No field or line ranks, scores or favours one. Order never depends on evidence counts.                                                                                                 | The #613 accepted risk. A fixed order means the layout itself cannot be read as a ranking.                                                                                                                                 |
| D2  | A third hypothesis, **environment/infrastructure**, sits beside the two the issue names.                                                                                                                                                                                                                                                                                 | A timeout or ECONNREFUSED forced into "test vs product" gets stamped test-defect by default — the exact escape mechanism. Adding a side is the conservative choice; it never narrows what the tool admits it doesn't know. |
| D3  | Self-contained skill CLI (`agents/skills/claude-code/canary-question/scripts/*.mjs`) reading the JSONL run-history store directly.                                                                                                                                                                                                                                       | Same shape as `canary-screech` / `canary-signal` (`canary-screech/scripts/history.mjs`); `ts/src/history` has zero headroom (#1074).                                                                                       |
| D4  | One input shape: `--test NAME` (required) plus optional `--history PATH`, `--suite NAME` (disambiguates a name that occurs in several suites), `--findings PATH` (one Tier-0 detector `--json` envelope), `--repo DIR` (git working tree for the diff signal, default `.`). Output `--json`, `--out PATH`.                                                               | Brief: one entry point, one input shape. The Tier-0 envelope is shared by savant/blackhawk/cassandra/katana, so one optional file covers every detector.                                                                   |
| D5  | **Fidelity** is derived, never asserted: `abstained` (0 observations of the test, or no failing observation), `thin` (fewer than 3 observations), `history` (≥3 observations, no diff read), `history+diff` (a git diff between the last passing and first failing commit was read). The denominator (observations, failures, runs in store) is always printed.          | #508 no-silent-abstention. Three is the smallest sample where one run is not the whole story (same constant as canary-signal D5).                                                                                          |
| D6  | Abstention is loud: an `ABSTAINED` banner with the denominator and the reason, and no hypothesis evidence at all. It still prints what would disambiguate.                                                                                                                                                                                                               | Evidence from zero observations is the false-green this repo keeps re-learning.                                                                                                                                            |
| D7  | Signals are deterministic and each names its source: same-commit mixed outcomes; `flaky` status / retry passes; regression shape (passes then consecutive failures); git diff of the test file vs non-test files over the culprit range; failure category (stored, else categorised from `error_text`); co-failures in the same run; detector findings on the test file. | Deterministic-first. Every signal is data canary already has.                                                                                                                                                              |
| D8  | A signal that does not discriminate says so: nondeterminism is listed as consistent with **all three** hypotheses (a product race produces it too), not as evidence for a flaky test. _Amended after review:_ the same principle now governs every row — a signal is not listed against a hypothesis that can also produce it (see the evidence-rows table).             | "Flaky therefore test bug" is the inference the ideation objection names.                                                                                                                                                  |
| D9  | Unreadable optional evidence is listed under **Not checked** with the reason (no history, git unavailable, commits unreachable, no findings file). An explicitly-passed path that does not exist is an error (exit 1).                                                                                                                                                   | "Cannot verify" is a finding, not a skip. A typo'd path must look like a typo'd path (`canary-screech/scripts/history.mjs`).                                                                                               |
| D10 | Exit codes: `0` always for a produced brief (including abstention), `1` unreadable named input or an `--out` that cannot be written (_amended after review:_ the brief is still printed to stdout first), `2` usage. No `--strict`.                                                                                                                                      | Advisory only: the tool must never fail a job on its own reading of the evidence.                                                                                                                                          |
| D11 | Output copy is guarded by a test that forbids verdict language (`verdict`, `root cause`, `is flaky`, `test bug`, `product bug`, `likely`, `probably`, `most likely`; _amended after review:_ also `suggest`, `points to`, `lean`, `rank`, `confiden`, `caused by`, `flaky test`, matched at a word start) and a `verdict`/`disposition`/`score` key in the JSON.         | The constraint is a property of the output, so it is asserted on the output.                                                                                                                                               |

### Approaches considered

1. **Self-contained skill over the JSONL store (chosen).** Low-medium
   complexity; identical shape to `canary-screech`; no engine headroom needed;
   avoids the `ts/src` arch ratchets. Cost: re-implements a small timeline
   reader rather than reusing `ts/src/history/detector.ts`.
2. **`canary question` engine subcommand** reusing `ts/src/history`
   (`detectRegressions`, the flake window). Rejected: `history/cli.ts` is at its
   15-import limit and the module at its LOC ceiling (#1074); a new subcommand
   also pays the perf-delta and arch-allowance ratchets.
3. **Prompt-only skill (SKILL.md instructs an agent to triage).** Rejected:
   judgement-first is exactly what the constraint forbids, and nothing about its
   output could be tested for the absence of a verdict.

## Technical design

### Files

```text
agents/skills/claude-code/canary-question/
  SKILL.md
  scripts/cli.mjs        # argv, I/O, exit codes (entry point, exec bit)
  scripts/history.mjs    # load JSONL store; timeline for one test
  scripts/signals.mjs    # pure: timeline (+ run context) -> evidence rows
  scripts/diff.mjs       # git diff --name-only over the culprit range
  scripts/findings.mjs   # Tier-0 envelope -> findings on the test file
  scripts/brief.mjs      # pure: evidence -> brief object
  scripts/render.mjs     # pure: brief object -> markdown / json
agents/skills/test/canary-question.test.ts
```

### Timeline

`history.mjs` loads the store (same strictness as screech: missing file and
malformed lines throw). For `--test` (and `--suite` when given) it collects one
observation per run containing the test (`run_id`, `suite`, `commit_sha`,
`timestamp`, `branch`, `status`, `failure_category`, `error_text`,
`retry_count`, `test_file`, `area`, `coFailures`, `testsInRun`), where
`coFailures` are the other failing tests of that run and `testsInRun` counts its
tests. Sorted by `timestamp`. If the name occurs in several suites and no
`--suite` was given, the brief abstains and lists the suites.

The **target failure** is the most recent observation with status `failed` or
`flaky`. If none exists the brief abstains ("no failing observation in N").

### Evidence rows

Each row: `{signal, source, detail, supports: [...], weighsAgainst: [...]}` with
hypotheses `test-defect`, `product-defect`, `environment`. The renderer places a
row under every hypothesis it names.

| Signal                  | Fires when                                                                                                        | Supports                              | Against     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| `same-commit-mixed`     | one `commit_sha` has both a pass and a failure of this test                                                       | all three (states non-discrimination) | —           |
| `retry-pass`            | status `flaky`, or `retry_count > 0` on a pass                                                                    | all three (states non-discrimination) | —           |
| `regression-shape`      | ≥1 pass, then the last ≥2 observations all `failed` on distinct commits, no pass since                            | test-defect, product-defect           | —           |
| `diff-test-only`        | culprit range touched the test file and no non-test file                                                          | test-defect                           | —           |
| `diff-sut-only`         | culprit range touched non-test files and not the test file                                                        | product-defect                        | —           |
| `diff-both`             | both touched                                                                                                      | test-defect, product-defect           | —           |
| `diff-none`             | culprit range touched nothing (same tree)                                                                         | environment                           | —           |
| `category-env`          | category `timeout` or `auth`                                                                                      | environment, product-defect           | —           |
| `category-env`          | category `network`                                                                                                | environment                           | —           |
| `category-server`       | category `server` (5xx)                                                                                           | product-defect, environment           | —           |
| `category-neutral`      | any other category — recorded as "does not discriminate"                                                          | —                                     | —           |
| `co-failure`            | other tests failed in the target run with the same category or area                                               | product-defect, environment           | —           |
| `unrelated-co-failures` | other tests failed in the target run, none sharing its category or area — "does not discriminate"                 | —                                     | —           |
| `isolated`              | the only failure in a target run of ≥2 tests (the run size is in `detail`)                                        | test-defect, product-defect           | environment |
| `single-test-run`       | the target run held only this test, or its size is unrecorded — isolation not observable, "does not discriminate" | —                                     | —           |
| `detector-finding`      | Tier-0 findings on the test's file, ONE row listing up to five `RULE@line` and counting the rest                  | test-defect                           | —           |

**Amended after review.** The first cut listed several one-sided signals
_against_ a hypothesis that can produce them too, which is a lean by another
name. Applying D8's principle to the whole table: `diff-test-only` and
`diff-sut-only` no longer weigh against the other code side (a changed test can
expose an existing product defect; an intended product change can leave a test's
expectation stale — each detail says so); `co-failure` no longer weighs against
test-defect (a shared test helper or fixture fails the same way);
`regression-shape` no longer weighs against environment (a persistent
environment change makes the same shape) and requires every streak observation
to be `failed` (`flaky` passed on retry); `timeout` and `auth` also support
product-defect, `server` also supports environment (502/503 are infrastructure);
`isolated` supports both code hypotheses (a narrow product regression fails
alone) and needs a run of ≥2 tests; detector findings collapse to one row so
volume cannot read as weight. The culprit range is Not checked when the pass and
the failure share a commit or the last pass is not an ancestor of the target
(git `merge-base --is-ancestor`; git runs with a 10s timeout, a 16 MiB buffer
and `--end-of-options`). An abstained brief lists the unread diff and findings
under Not checked. A test record with no suite is labelled `(no suite)`, and
`--suite '(no suite)'` selects it.

Culprit range = last passing observation's `commit_sha` → target failure's
`commit_sha`. A test file is recognised by `.test.`/`.spec.` infixes,
`test_*.py`/`*_test.py`/`*_test.go`, or a `test/`/`tests/`/`__tests__/` path
segment. If `test_file` is absent from the record, diff rows compare "test-like
paths" vs the rest and say so in `detail`.

### Disambiguation

A deterministic list, derived from what is missing or in tension, e.g.: re-run
the test several times at `<target sha>` (nondeterminism check); run
`canary-savant --confirm` on the test file (order dependence); check out
`<last pass sha>` with only the test file from `<target sha>` (isolates a test
change); run the test against `<last pass sha>`'s SUT; record more runs (when
thin). Always at least one item.

### Output

Markdown (stdout, and `--out`): header naming the test, a banner "Evidence brief
— hypotheses and evidence, no call made", fidelity + denominator line, one
section per hypothesis (For / Against), Not checked, What would disambiguate.
`--json`:

```json
{
  "schema_version": 1,
  "advisory": true,
  "test": "...",
  "suite": "...",
  "fidelity": "abstained | thin | history | history+diff",
  "denominator": { "observations": 0, "failures": 0, "runs_in_store": 0 },
  "target": {},
  "hypotheses": [{ "id": "test-defect", "for": [], "against": [] }],
  "not_checked": [{ "source": "...", "reason": "..." }],
  "disambiguate": ["..."],
  "abstained": null
}
```

## Integration Points

### Entry Points

- New bundled executable skill `canary-question` (`cli: scripts/cli.mjs`), run
  via `canary skills run canary-question -- --test <name> ...`.

### Registrations Required

- `harness.config.json`: `scripts/cli.mjs` in **both** `entropy.entryPoints`
  arrays.
- `agents/skills/package.json` `format:check` glob and
  `agents/skills/vitest.config.ts` coverage `include`.
- Discovery-driven suites pick it up automatically
  (`skill-cli-conformance.test.ts`, `ts/test/skill-examples.test.ts`).

### Documentation Updates

- `agents/skills/README.md` (tree + bundled-skill list + `scripts/cli.mjs`
  list), `docs/naming-registry.md` (reserved → shipped), `docs/roadmap.md` row,
  `CHANGELOG.md` Unreleased.

### Architectural Decisions

- None warrant an ADR: the skill follows the established self-contained
  skill-CLI pattern. D1 (evidence, never verdict) is recorded here and in
  SKILL.md.

### Knowledge Impact

- Concept: _evidence brief_ — hypotheses with for/against evidence and a derived
  fidelity label, as the safe alternative to a classifier where a wrong answer
  is worse than none.

## Success Criteria

1. When the store has no observation of `--test`, the brief prints `ABSTAINED`
   with `observations: 0` and exits 0.
2. When the test has observations but none failing, the brief abstains with the
   observation count.
3. When the test has fewer than 3 observations, fidelity is `thin` and a THIN
   EVIDENCE banner is printed.
4. When one commit shows both a pass and a failure, `same-commit-mixed` appears
   under all three hypotheses.
5. When the culprit range touched only the test file, `diff-test-only` is
   evidence for test-defect (and, since the review amendment, not against
   product-defect); symmetric for `diff-sut-only`; fidelity is `history+diff`.
6. When git cannot resolve the range, the diff appears under Not checked with
   the reason and fidelity stays `history`/`thin`.
7. A Tier-0 finding on the test file appears as test-defect evidence quoting the
   rule id; findings on other files are ignored.
8. The hypothesis order is identical for every input (asserted across fixtures
   that favour each side).
9. No output (markdown or JSON) across every fixture contains the forbidden
   verdict phrases or keys (D11).
10. Exit code is 0 for every produced brief, 1 for a named-but-missing
    `--history`/`--findings`, 2 for usage errors; `--help` exits 0.
11. The skill passes the discovery-driven conformance and SKILL.md example
    suites, and the four gates plus the entropy ratchet stay green.

## Implementation Order

1. Timeline reader (`history.mjs`) + abstention paths.
2. Pure signals (`signals.mjs`) for history-derived signals.
3. Findings reader and diff reader (`findings.mjs`, `diff.mjs`).
4. Brief assembly + renderers (`brief.mjs`) with the forbidden-language guard.
5. CLI (`cli.mjs`), SKILL.md, registrations, docs.
