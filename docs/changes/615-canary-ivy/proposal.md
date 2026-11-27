# canary-ivy: suite overgrowth report, never a deletion list (#615)

**Keywords:** suite overgrowth, duplicated fixtures, coverage overlap, runtime
creep, run-history, report-only, abstention, deletion invariant, skill

## Overview

Issue #615 (ideation rank 10,
`docs/ideation/bop-themed-canary-skills-2026-07-21.md`, candidate 10) asked for
"suite overgrowth and pruning".
[ADR 0039](../../knowledge/decisions/0039-canary-ivy-report-only.md) (accepted
2026-10-15) reshaped it before this spec: **canary-ivy reports suite overgrowth
and never recommends deleting a test.** This spec implements that ADR and is
bound by every line of it. Where the two disagree, the ADR wins.

Ivy reports three suite-level facts and nothing else (ADR 0039, Decision 1):

1. **Duplicated fixtures:** the same setup body defined in more than one place,
   with every location.
2. **Overlapping coverage:** sets of tests whose covered lines coincide, with
   the shared lines named, and in every finding the statement that shared line
   coverage does not show that the tests assert the same behaviour.
3. **Runtime creep over history:** per-test and per-file duration trends read
   from the run-history store, showing where suite time went and when it grew.

It serves STRATEGY.md's target problem by refusing the move it warns about
(`STRATEGY.md`, "Target problem": line coverage can be maxed out by
assertion-free tests). A coverage-overlap tool that ranked tests for deletion
would turn that defect into advice. Ivy names what overlaps and what grew, and
leaves every decision to the human (ADR 0039, Decision 2).

### Out of scope (non-goals)

- **Any recommendation to delete, remove, prune, drop, skip, quarantine or
  merge-away a test**, in any output surface. Any removability rank, score,
  field or "least needed first" ordering. Changing this needs a new ADR that
  supersedes 0039 (ADR 0039, Consequences).
- **Any gate.** Findings never exit 1. There is no `--strict`.
- **A readiness verdict, a pass/warn/fail runtime grade, a p95, or writing perf
  baselines.** Those stay with `canary-ci-ready` (ADR 0039, Decision 3).
- **Per-test grading** (assertions, selectors, timing, readability, fixture
  scope). That stays with `canary-test-reviewer` (ADR 0039, Decision 3).
- **Producing per-test coverage.** Ivy reads it. It does not run tests or
  instrument them.
- **Any new field in the run-history store.** Ivy reads the existing
  `duration_ms` (ADR 0039, Consequences; ADR 0030 additive rule not exercised).
- **New engine code under `ts/src/history`** (at its LOC ceiling, #1074).

## Decisions made

Autonomous fleet lane (`roadmap-fleet-2026-11-27`): every EVALUATE question was
answered with the recommended default and is recorded as an assumption in
`provenance.json`. Brainstorming, planning, execution, verification and review
ran inline in one agent (no sub-agents).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Self-contained Tier-0 skill CLI at `agents/skills/claude-code/canary-ivy/scripts/*.mjs`, run as `canary skills run canary-ivy`. It reads the JSONL run-history store directly.                                                                                                                                                                                                                     | Same shape as `canary-question` and `canary-screech` (`agents/skills/claude-code/canary-question/scripts/history.mjs`). `ts/src/history` has no headroom (#1074). Skill `.mjs` sits outside the arch module-size measurement.                              |
| D2  | **Per-test coverage source (ADR 0039, Consequences):** `--coverage PATH` accepts (a) coverage.py JSON written with `coverage json --show-contexts` from a run with `--cov-context=test` (dynamic contexts), and (b) a minimal neutral map `{"schema_version": 1, "tests": {"<test id>": {"<file>": [lines]}}}`.                                                                                    | coverage.py dynamic contexts are a real, shipped per-test producer. The neutral map lets any other tool (or a JS harness) feed ivy without ivy owning a producer. When `--coverage` is absent the signal is an explicit "not assessed" row, never dropped. |
| D3  | **Overlap means identical covered-line sets.** Tests are grouped only when their covered `(file, line)` sets are exactly equal and non-empty. Subset relations ("A covers nothing B does not") are not reported.                                                                                                                                                                                   | ADR 0039 says "covered lines coincide". A subset report is the original pruning premise in disguise: it reads as "A adds nothing". Equality is the narrowest fact that answers "where do tests overlap".                                                   |
| D4  | Every overlap finding carries `caveat`: _"Shared line coverage does not show that these tests check the same behaviour. Read their assertions; each one may be the only check of something the lines do not reveal."_                                                                                                                                                                              | ADR 0039, Decision 2, bullet 3: the statement is in the finding itself, and points at the assertions.                                                                                                                                                      |
| D5  | **Duplicated fixtures are body-identical setup blocks**, line-scanned (no parser): pytest `@pytest.fixture` functions, `setUp` / `setup_method`, JS/TS `beforeEach` / `beforeAll`, PHP `setUp` / `set_up`. A block is compared on its normalized body (comments and blank lines dropped, whitespace collapsed) and must have at least 2 body lines.                                                | The ADR's fact is "the same setup exists in N places". Name-only matches are not the same setup. The two-line floor keeps one-line `vi.restoreAllMocks()` hooks, which are idiom rather than overgrowth, out of the report.                                |
| D6  | **Runtime creep is a changepoint, not a grade.** Per test (`test_file` + `test_name`) and per file (summed per run), ordered by run `timestamp`, the split that maximizes the gap between the mean before and after is the "grew at" run. A series is reported when it has at least 6 observations, its median after the split is at least 1.5x its median before, and the gap is at least 100 ms. | ADR 0039, Decision 3: "where did the time go, and when did it grow". The thresholds are inclusion rules for a list, stated in the output, not pass/warn/fail grades. Medians, never p95, so ivy never re-scores what ci-ready scores.                      |
| D7  | "Where the time went": the 10 files with the largest median duration over the most recent 5 runs that contain them, each with its share of the summed total.                                                                                                                                                                                                                                       | The ADR's "showing where suite time went". Attribution only, no threshold.                                                                                                                                                                                 |
| D8  | **Exit codes:** 0 when at least one of the three sections was assessed, whatever it found. 3 (ADR 0009) when none was: no test file found, no coverage given, no usable history. 1 only for I/O errors (a named input that cannot be read, `--out` that cannot be written). 2 for usage.                                                                                                           | ADR 0039, Decision 2: never a gate, abstain with 3. Exit 1 for I/O follows `canary-question` (A6 in its provenance) and is never produced by a finding.                                                                                                    |
| D9  | **Per-section abstention.** Each section carries `status`, either `assessed` or `not_assessed`, a `reason` when not assessed, and its denominator. A not-assessed section is printed as a row, never omitted.                                                                                                                                                                                      | ADR 0039, Consequences: "must not drop the signal silently". A clean-looking report over zero inputs is the false green the repo keeps re-learning.                                                                                                        |
| D10 | **One shared escaping helper** (`scripts/text.mjs`). `plain()` strips ANSI escape sequences, replaces newlines, C0/C1 control characters and Unicode line/bidi controls with a space, collapses whitespace and clamps length. `md()` is `plain()` plus Markdown metacharacter escaping. Every input-derived value reaching Markdown, JSON, stdout or stderr passes through one of them.            | Test names, file paths, fixture bodies, coverage keys and history fields are attacker-controllable text (a hostile branch can name a test anything). Without this a name could forge report lines, terminal escapes or Markdown links.                     |
| D11 | `--out PATH` follows the sibling convention (`canary-question/scripts/cli.mjs`, `writeArtifact`): parent directories are created, the same text printed to stdout is written, and a failure prints `canary-ivy: cannot write artifact: <reason>` and exits 1.                                                                                                                                      | Brief requirement and family convention.                                                                                                                                                                                                                   |
| D12 | `--history` has no default value in the parser. Absent, ivy reads `test-results/reports/history-v2.jsonl` if it exists and otherwise marks runtime creep not assessed. A **named** store that is missing or malformed is exit 1.                                                                                                                                                                   | Same device as `canary-question` (spec D9): a typo must look like a typo, while a repo that never recorded history is a dark source, not an error.                                                                                                         |
| D13 | Ordering carries no "least needed" meaning: fixture groups by location count then path; overlap groups by size then first test id; creep rows by growth in ms; time rows by share.                                                                                                                                                                                                                 | ADR 0039, Decision 2, bullet 2.                                                                                                                                                                                                                            |

### Approaches considered

| Approach                                                                        | Verdict  | Why                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Self-contained skill (`scripts/*.mjs`) reading files and the JSONL store** | chosen   | Matches canary-question/screech. Deterministic, no engine import, no arch module-size cost. Store schema stays read-only (ADR 0039 Consequences).                                                                            |
| B. Engine subcommand `canary ivy` under `ts/src`                                | rejected | Reaches the async store contract (ADR 0013) and Supabase, but `ts/src` is at its arch and perf ceilings (#1074) and the JSONL store is the documented local source. Could follow later without changing the output contract. |
| C. Prompt-only skill (agent reads the suite and reports)                        | rejected | Not deterministic, so the deletion-vocabulary invariant could not be tested: an LLM paraphrase could recommend deletion in words no fixed scan anticipates.                                                                  |
| D. Fold into canary-ci-ready / canary-test-reviewer                             | rejected | Settled by ADR 0039, Alternatives (c).                                                                                                                                                                                       |

**Supersession check (ADR 0039, Decision 4).** After the boundary in Decision 3,
what remains is not "a flag on canary-ci-ready": cross-file fixture identity and
per-test coverage overlap are visible nowhere in canary today, and runtime creep
is attributed by test and file over history rather than graded now. No new
decision is needed.

## Technical design

### Files

| File                                            | Responsibility                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `agents/skills/claude-code/canary-ivy/SKILL.md` | Contract, invocation, exit codes, invariant, boundaries.                    |
| `.../canary-ivy/scripts/cli.mjs`                | `CLI_SPEC`, I/O orchestration, exit codes, `--out`.                         |
| `.../canary-ivy/scripts/text.mjs`               | The one escaping helper (`plain`, `md`).                                    |
| `.../canary-ivy/scripts/fixtures.mjs`           | Test-file walk, setup-block extraction, identical-body grouping.            |
| `.../canary-ivy/scripts/coverage.mjs`           | Read both coverage formats, invert to per-test line sets, group equal sets. |
| `.../canary-ivy/scripts/runtime.mjs`            | Read the JSONL store, build series, changepoint, time attribution.          |
| `.../canary-ivy/scripts/report.mjs`             | Assemble sections, render Markdown and JSON.                                |
| `agents/skills/test/canary-ivy*.test.ts`        | Unit + CLI tests, including the planted invariant test.                     |

### Report shape (`--json`)

```json
{
  "schema_version": 1,
  "tool": "canary-ivy",
  "abstained": false,
  "sections": {
    "fixtures": {
      "status": "assessed",
      "denominator": { "files_scanned": 12, "setup_blocks": 30 },
      "groups": [
        {
          "kind": "pytest-fixture",
          "body_lines": 4,
          "first_line": "db = make_db()",
          "locations": [
            { "file": "tests/a/conftest.py", "line": 8, "name": "db" }
          ]
        }
      ]
    },
    "coverage": {
      "status": "assessed",
      "denominator": { "tests_with_coverage": 40 },
      "caveat": "Shared line coverage does not show ...",
      "groups": [
        {
          "tests": ["tests/test_a.py::test_x", "tests/test_a.py::test_y"],
          "line_count": 7,
          "shared_lines": [{ "file": "src/a.py", "ranges": "3-7,9-10" }],
          "caveat": "Shared line coverage does not show ..."
        }
      ]
    },
    "runtime": {
      "status": "assessed",
      "denominator": {
        "runs": 30,
        "timed_tests": 200,
        "series_long_enough": 150
      },
      "thresholds": {
        "min_observations": 6,
        "min_ratio": 1.5,
        "min_gap_ms": 100
      },
      "where_time_went": [
        { "file": "tests/e2e/a.spec.ts", "median_ms": 9000, "share": 0.41 }
      ],
      "creep": [
        {
          "scope": "test",
          "file": "tests/e2e/a.spec.ts",
          "test": "loads the dashboard",
          "before_median_ms": 800,
          "after_median_ms": 2400,
          "gap_ms": 1600,
          "observations": 12,
          "grew_at": {
            "timestamp": "...",
            "commit_sha": "...",
            "run_id": "..."
          }
        }
      ]
    }
  }
}
```

A not-assessed section is `{ "status": "not_assessed", "reason": "..." }` plus
whatever denominator was measured. Field names are fixed by the invariant test:
none may match the deletion vocabulary.

### Markdown

A title, a one-line banner (_"Report only: what overlaps and what grew. Every
decision about a test stays with you."_), then one `##` section per signal in a
fixed order (fixtures, coverage, runtime). Each section opens with its status
and denominator. Lists are capped at 50 entries with a "N more in --json" line.
An all-not-assessed run prints the family's abstention line
(`⚠ Abstained — verified zero items; this is not a pass.`).

### Escaping (D10)

`plain(v, max = 160)`: `String(v ?? '')`, strip CSI / OSC / two-byte ESC
sequences, replace `[\u0000-\u001f\u007f-\u009f  ]` and bidi controls
(`‎‏‪-‮⁦-⁩`) with a space, collapse whitespace, trim, clamp by code point with a
trailing `...`. `md(v, max)` escapes ``\ ` * _ [ ] ( ) # + ! | < > ~ { } &``
after `plain`. Numbers are formatted by ivy and do not pass through it.

## Integration Points

### Entry Points

- New bundled executable skill `canary-ivy` (`cli: scripts/cli.mjs`), reachable
  as
  `canary skills run canary-ivy -- [paths] [--coverage PATH] [--history PATH]`,
  plus `--json` and `--out PATH`.

### Registrations Required

- `.claude-plugin/plugin.json` `skills` list.
- `harness.config.json` `entropy.entryPoints` and `performance.entryPoints`
  (`canary-ivy/scripts/cli.mjs`, both arrays, as for every sibling).
- `agents/skills/vitest.config.ts` coverage `include` and
  `agents/skills/package.json` `format:check` globs.
- `docs/naming-registry.md`: `canary-ivy` `reserved` → `used`, purpose updated
  (ADR 0039, Consequences, follow-up).

### Documentation Updates

- `agents/skills/README.md`: tree, catalogue entry, bundled-executable list.
- `CHANGELOG.md` `[Unreleased]`.
- `docs/roadmap.md` row for #615.
- SKILL.md is the user-facing contract.

### Architectural Decisions

None new. ADR 0039 is the governing decision; D2 (coverage source) is the one
choice it delegated to this spec, and it is recorded here.

### Knowledge Impact

ADR 0039 named three consumers of the history store (ci-ready, rewind, ivy). Ivy
reads `timestamp`, `commit_sha`, `run_id`, and per-test `test_file`,
`test_name`, `duration_ms`. A schema change to those fields has a third consumer
to check.

## Success Criteria

1. **SC1 (planted invariant, ADR 0039 Decision 2 bullet 5):** given two tests
   with identical line coverage and different assertions, ivy reports one
   overlap group naming both tests and the shared lines, and the full Markdown
   and JSON output, scanned against a deletion-vocabulary denylist (delete,
   remove, prune, drop, skip, quarantine, merge, redundant, removable, safe to
   delete, unnecessary, obsolete, superfluous, unneeded, consolidate), matches
   nothing. The same scan runs over the abstention and error messages the CLI
   emits.
2. **SC2:** every overlap group in Markdown and JSON carries the caveat text.
3. **SC3:** no output field or key is named `removable`, `safe_to_delete`,
   `redundant`, or carries a score; ordering follows D13.
4. **SC4:** when no section can be assessed, the exit code is 3, the abstention
   line is printed and no "no findings" copy appears. When any section is
   assessed, the exit code is 0 regardless of findings.
5. **SC5:** a missing named `--coverage` / `--history` / path input exits 1 with
   a cleaned message; an unwritable `--out` exits 1 with
   `cannot write artifact:`; a bad flag exits 2.
6. **SC6:** the same fixture body in two files is one group with both locations;
   bodies that differ by a line are not grouped; one-line hooks are ignored.
7. **SC7:** both coverage formats yield the same groups for the same data; tests
   whose line sets differ by one line are not grouped.
8. **SC8:** a series that steps from ~800 ms to ~2400 ms at run k reports
   `grew_at` = run k; a flat series is not reported; a series under 6
   observations counts toward the denominator and is not reported.
9. **SC9:** output never contains `p95`, `pass`/`warn`/`fail` grades, or
   "ready"; ivy writes nothing but `--out`.
10. **SC10 (security):** a test name, file path, fixture body, coverage key and
    history field carrying newlines, ANSI escapes, control characters, Markdown
    link syntax and 10 000 characters is rendered on one line, escaped, clamped,
    and without the escape byte, in Markdown, JSON and stderr.

## Implementation Order

One phase, test-first, one commit per task:

1. `text.mjs` escaping helper.
2. `fixtures.mjs` walk and grouping.
3. `coverage.mjs` both readers and grouping.
4. `runtime.mjs` store reader, changepoint and attribution.
5. `report.mjs` assembly and rendering.
6. `cli.mjs` flags, exit codes, `--out`, and the planted invariant test.
7. SKILL.md, registrations, docs, naming registry, roadmap, CHANGELOG.
