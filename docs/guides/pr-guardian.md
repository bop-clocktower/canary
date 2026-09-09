---
project: canary
created: 2026-07-19
---

# PR Guardian — operator guide

`canary-pr-guardian` is a per-change test-quality loop. On every pull request
(and, optionally, at pre-commit) it scopes the diff, decides whether the
new/changed code is tested, and posts ranked, **fidelity-labeled** findings —
then, where an agent runtime exists, authors the missing tests. It is the
PR-scoped, write-capable sibling of the on-demand `canary-test-pipeline`.

Its defining property is **graceful degradation**: the deterministic core
(diff-coverage → comment) runs on stock CI with no agent, no secret, and no
write token, so the baseline value — findings on every PR — is guaranteed.
LLM-driven audit and authoring are additive tiers that engage only where a
runtime lives. See ADR 0007 (capability boundary) and ADR 0008 (ownership) for
the design rationale.

## What it does

- **Scopes the diff** (`git diff`), filtering out non-source paths via
  `skipGlobs` (docs, lockfiles, build output, generated command artifacts).
- **Resolves coverage** at the highest available fidelity per changed unit (see
  [Fidelity labels](#fidelity-labels)).
- **Renders findings** ranked by severity onto a sticky PR comment (upsert by
  marker `<!-- canary-pr-guardian -->`, so re-runs replace rather than stack).
- **Emits a harness analysis** (`--emit-analysis`) so the result surfaces inside
  the harness gate flow rather than as an orphaned parallel comment.
- **Authors tests** at the desk (in-session / pre-commit) when a runtime exists.
- **Flags weak added tests** — an added test that defines a test function but
  asserts nothing gets an **advisory** `weak-test` finding. It is **never
  gating**, even under `gate: hard` — it surfaces the gap, never blocks the
  merge. Disable with `canary.guardian.pr.weakTests: false`.

  The signal is tuned for precision over recall (it should not nag on correct
  tests): snapshot/table-driven tests and the common assertion styles (`expect`,
  `assert`, chai `.should`, `pytest.raises`, `assert_*` helpers in Python and
  `expect*` helpers in JS/TS) all count as asserting, and a rename that adds
  only a signature line is ignored. The `expect*` half is [#738] — a Playwright
  suite that routes its checks through `expectRouteTestId(...)`, the pattern
  Playwright's own docs recommend, had every added spec flagged; the pytest side
  had recognised the same convention under its own spelling since day one.

  The span it scores is the **enclosing test block** of each changed line, not
  the changed hunk ([#747]). Scoring the added lines alone reported every
  arrange/act-only edit as assertion-free, because a test's setup is edited far
  more often than its `expect` — the assertion sat one line past the last `+`
  line, as a context line. The block is resolved from the diff's own context
  lines by walking up to the nearest `it`/`test`/`def test_` declaration and
  down to the end of that block; a `describe` group does not count, so an empty
  test beside an asserting sibling is still caught. A changed line whose
  enclosing test **cannot** be resolved — a Playwright `setup(...)` fixture, a
  bare helper — is abstained on rather than reported.

  Known limits — the span is bounded by what the diff shows, so an assertion
  further down a block than the diff's context window may be missed; and a test
  whose only check is a custom helper named on neither convention (e.g.
  `verify_response(resp)`) may be flagged. Since the finding is advisory, the
  escape hatch is the `weakTests` toggle.

## Surfaces and how to enable them

Configuration lives in a `canary.guardian` block in `harness.config.json`. Each
surface toggles independently; a malformed block warns loudly (never silently
defaults).

```jsonc
"canary": {
  "guardian": {
    "pr":        { "enabled": true,  "tier": 0, "gate": "soft" },
    "preCommit": { "enabled": false, "authorTests": true, "gate": "soft" },
    "coveragePaths": ["coverage.xml", "coverage/lcov.info"],
    "skipGlobs": ["docs/**", "**/*.md"]
  }
}
```

Two different exclusion knobs, easily confused:

| Key                   | Scope                   | Effect                                                                                                                                                |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skipGlobs`           | the whole gate          | The path is dropped before any tier runs — no finding at any fidelity.                                                                                |
| `pr.heuristicExclude` | the heuristic tier only | The path is still scored; only an **uncovered heuristic** verdict is suppressed. A coverage- or graph-verified finding on that same path still fires. |

Reach for `heuristicExclude` when a path _can_ carry real coverage evidence but
the naming heuristic would only guess (generated clients, ambient `.d.ts`
declarations). Reach for `skipGlobs` when the path should never be judged at
all.

Both follow the same present-vs-absent contract: omit the key to keep the
built-in default, or supply an explicit list — including `[]`, which means
"nothing" rather than "use the default".

There are also two suppressions that are **not** configurable, because no repo
should want them off.

The first (#565): a file that is _test support by name_ — a pytest `conftest`
(`conftest.py`, `conftest_otel.py`), or a module with a `fixture` / `fixtures`
basename component (`playwright-fixture.ts`, `fixture_helpers.py`,
`user.fixtures.ts`) — is dropped before any tier runs, alongside test paths
themselves. Such a file _is_ the harness the tests run inside, so "write a test
covering it" inverts the relationship the gate exists to check, at every
fidelity. Matching is on `-`/`_`/`.`-separated basename components, so
`conftestimonial.py` and `prefixtures.ts` are ordinary source and still judged.

The second (#562): a **type-only module** — a TypeScript file whose every
top-level statement is erased at compile time (interfaces, type aliases, type
imports). An interface has no runtime existence, so no test can execute its
lines; lcov reports them all uncovered, accurately, and the resulting finding is
still unsatisfiable. Note this is the one class `heuristicExclude` cannot help
with: the verdict arrives `coverage-verified`, on real evidence, so the
heuristic-tier knob never applies.

A third distinction is per-**line** rather than per-file ([#655]). A changed
line with no record in the coverage report is **not coverable** — a comment, an
import, a `type`/`interface` declaration, a blank line, a closing brace — and is
counted by neither side of the ratio, because lcov and Cobertura both enumerate
every line they instrumented. Scoring absence as a miss made a wholly-new,
fully-tested file report as almost entirely uncovered, since every line of a new
file is a changed line: the finding's size came out as exactly
`file length − instrumented lines`. If no changed line in a unit is coverable,
the report has nothing to say about it and the guardian abstains for that unit,
falling through to the graph or heuristic tier rather than inventing either a
pass or a finding.

The rule is per-**report**, because absence only means "not coverable" where the
report says what it measured. lcov and Cobertura say so by construction. The
`coverage.json` contract does not: a line absent from both of its fields is
uncovered, and its `covered_lines` shorthand cannot express an unhit line at
all, so absence there counts as a miss.

A coverage-json producer can opt in to the lcov rule per file by declaring
`instrumented_lines` ([#657]) — the set of lines its tool actually measured.
Changed lines outside that set are then not coverable, exactly as for lcov. A
document without the field is read as before, so this changed no existing
producer. `canary guardian validate-coverage` warns when a document leans on
`covered_lines` and cannot express a miss at all, which is what transcoding lcov
into the format produces.

Detection is two-stage and content-confirmed, never name-only. A filename gate
(`types.ts`, `*.types.ts`, a `types/` directory, `*.d.ts`) decides which files
are worth reading; the file is then suppressed **only** if it contains no
runtime code. A `types.ts` that also exports an `enum`, a `const` map, or runs a
statement is ordinary TypeScript and keeps its findings. Every uncertainty — an
unreadable file, an unrecognised construct — resolves to "not type-only", so the
finding survives.

Suppressed paths are always named in the skip list with their cause, grouped by
reason so a shared cause is stated once
(`3 skipped: docs/x.md, docs/y.md [skipGlobs]; src/types.ts [type-only module]`),
never folded into a pass. Under `--format json` the payload carries the same
list as `skipped: [{name, reason}]` — on the abstain path since #579, and on
every ordinary run since #582 — so a machine consumer can tell _what_ was
dropped and _why_, not merely that the gate declined to answer. See
[What did this run decline to judge?](#what-did-this-run-decline-to-judge) for
the reason vocabulary.

### PR check

Set `canary.guardian.pr.enabled: true`. The stock workflow
(`.github/workflows/guardian.yml`) installs canary and runs
`canary guardian pr-check --post-comment` (Tier 0). Docs/config-only diffs
(matching `skipGlobs`) are skipped with a "nothing to verify" notice.

### At-desk check and authoring (the `preCommit` surface)

Set `canary.guardian.preCommit.enabled: true`, and opt in to authoring with
`authorTests: true`. When new code is untested the guardian authors the missing
tests, `git add`s them, and **stops once** with a "N tests authored & staged —
review and re-commit" message. No autonomous commit, no push. `authorTests`
defaults to `false` so a runtime-less desk degrades quietly.

**There is no bundled git hook.** This surface is driven **in-session by the
`canary-pr-guardian` skill**, which calls the engine through two CLI seams:

- `canary guardian author-plan --json` — the authoritative plan (per-gap intents
  plus the block decision). The engine's guards (opt-in, tier, fork, collision,
  loop-guard) are decided here; the skill honors every `skipped` reason verbatim
  and never overrides one.
- `canary guardian mark-authored --path <p> …` — records the authored paths in a
  loop-guard sentinel (`canary-guardian-authored`, inside the real git dir)
  before stopping.

The `preCommit.*` config keys are live and govern this surface — `authorTests`
sets the requested tier, `preCommit.gate` sets the graph-coverage depth — but
they are read by `author-plan`, **not** by any git hook. The repo's own git hook
(`.githooks/pre-commit`, installed with `git config core.hooksPath .githooks`)
runs markdownlint, the roadmap comment guard, and the security ledger; it does
not invoke the guardian.

**The loop guard expires on your next commit.** `mark-authored` stamps the
sentinel with the `HEAD` it authored at (a `HEAD <sha>` header above the paths),
and `author-plan` honors the guard **only while `HEAD` still matches**. Review
the staged tests, commit them, and `HEAD` moves — the stamp stops matching and
authoring is available again with no manual step. Nothing needs to clear the
file. Any sentinel that cannot be verified — missing, unreadable, no `HEAD`
header, or an unresolvable `HEAD` — **fails open**, so a stale file can never
wedge authoring off (#456).

## Fidelity labels

Every finding is labeled by **how it was derived** — never treat a heuristic
guess as execution truth. Highest available fidelity wins per unit:

| Label               | Derived from                                           | Meaning                                                           |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `coverage-verified` | a coverage report (`coverage.xml`/`lcov.info`/`.json`) | changed lines mapped to covered/uncovered — strongest             |
| `graph-verified`    | the harness graph (`.harness/graph/`, via CLI/file)    | a changed file has no covering-test edge                          |
| `heuristic`         | naming/AST                                             | no `*.test.*`/`test_*.py` references the changed symbol — weakest |

Recognized coverage-report formats: `lcov.info` (`DA:` records), the canary
coverage-json shape ([contract](../specs/coverage-json-contract.md); validate a
producer with `canary guardian validate-coverage <file>`), and Cobertura
`coverage.xml` (line-level; the canonical `<class filename><line number hits>`
shape emitted by coverage.py, Istanbul, SimpleCov, and Jacoco→Cobertura
converters — branch data is not yet consumed). A well-formed XML that is not
Cobertura is rejected rather than guessed at, and falls through to the next
tier.

If no coverage report exists, the guardian falls back to the graph; with no
graph, it falls back to the heuristic. Absence degrades — it never blocks.

### What mode was this run in?

Degrading quietly is correct; degrading _unrecorded_ is not. Every run states
the coverage input's actual state, so "no coverage findings" can never be
misread as "the changed lines are covered":

| Status        | Means                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `verified`    | the report spoke to **every** changed file                                                                |
| `partial`     | it spoke to some; the rest fell back to graph/heuristic                                                   |
| `unavailable` | it spoke to **none** — no report, missing file, unparseable, or a report that matched nothing in the diff |

The state appears in three places:

- the analysis record's `coverage` block (`schemaVersion` 1.1, additive) —
  `{status, requested, found, parsed, filesInReport, unitsMatched, unitsTotal}`,
  plus the same fact in prose in `degradedNotice`;
- the sticky PR comment body, which drops the ✅ all-clear headline when
  coverage was not `verified`;
- `--format json` output (`coverage` + `degraded_notice`) and an Actions
  `::warning::` annotation.

`unitsMatched` of `unitsTotal` is the denominator to read. **Zero files matched
is an abstention, not a pass.**

Since [#761] the run says so with its exit code and its headline, not only in
the body. A run that judged units but resolved **no** coverage, and whose every
finding is therefore a naming-heuristic guess, **abstains**: it exits 3, and its
headline reads `abstained: no coverage data (N files judged heuristically)`
instead of `N files need test coverage`. The findings stay in the comment, the
`--format json` payload, and the analysis record (with `abstained: true`) — they
are useful, they are simply not a coverage verdict, and a count headline is what
makes a reader take them for one. This is a **different denominator** from the
abstention below: that one fires when the diff carried no findings-eligible
units at all, while this one fires on a diff full of them whose lcov never
reached the runner. A single coverage- or graph-verified finding means the run
measured something and is a result, not an abstention.

A run with **no** findings is left as it was: it states nothing a reader can
mistake for a measurement, because its headline already says
`no gaps found, but coverage was unavailable`.

Both `schemaVersion` bumps since 1.0 are purely additive: every 1.0 field keeps
its name, type, and meaning. Consumers should compare the **major** component
(`1`) rather than the whole string — a strict `=== "1.0"` check rejects a record
it can read perfectly well.

The minor bumps when an added field carries a _verifiability_ claim — one whose
absence would otherwise read as good news. `coverage` is such a field: missing,
it looks like "coverage was fine" when it actually means "this producer could
not say". So `>= 1.1` is what licenses a reader to trust the `coverage` block.
Fields that are merely more detail do not move it.

`skipped` (1.2) is the same kind of field, which is why it moved the minor too:
absent, it reads as "nothing was filtered out", when it may mean "this producer
never said". `>= 1.2` is what licenses a reader to trust it.

### What did this run decline to judge?

`checked` is a numerator. `skipped` is the rest of the fraction — one entry per
filtered path, carrying the class that filtered it:

| `reason`               | The path was                                                |
| ---------------------- | ----------------------------------------------------------- |
| `skipGlobs`            | matched by a configured `skip_globs` pattern                |
| `test path`            | a test itself — a test does not need its own test           |
| `test support`         | test infrastructure (a `conftest`/fixture module)           |
| `type-only module`     | types with no runtime content, so uncovered by construction |
| `re-export barrel`     | a pure re-export with nothing to execute                    |
| `heuristic-ineligible` | outside what a naming heuristic can judge                   |

It appears in `--format json` and in the analysis record, always as an array —
`[]` means "nothing was dropped", never "unknown". The reasons are distinct
tokens on purpose: adjudication measures suppression classes over time from
them, which is what makes a precision regression in a single filter visible
rather than averaged away.

Without it, `checked: 3` cannot distinguish a diff of three source files from a
diff of eight where five were filtered out — the same "the engine knows
something the output never says" class the `coverage` block closed one layer up.

One historical caveat: `checked` and `abstained` were added additively _under_
"1.0", before that rule existed. A "1.0" record may or may not carry them, and
no version comparison will tell you which — test for the key, not the version.

## The tier ladder

| Tier  | Adds                     | Runtime           | Write | Status                  |
| ----- | ------------------------ | ----------------- | ----- | ----------------------- |
| **0** | diff-coverage → comment  | none              | no    | default, ships now      |
| **1** | + LLM test-quality audit | agent (read-only) | no    | opt-in (desk in v1)     |
| **2** | + author + push tests    | agent             | yes   | opt-in (desk authoring) |

`pr.tier` defaults to `0`. Tiers 1/2 are opt-in and require a Claude-compatible
runtime. The agent tiers sit behind the `AgentTier` capability boundary
(`ts/src/guardian/agent-tier.ts`); the Tier 0 engine never imports them. The
`CANARY_GUARDIAN_AGENT` environment marker signals when an agent runtime is
present so the guardian can engage Tiers 1/2.

**Loud degradation.** Opting into a tier whose runtime is absent runs Tier 0 and
emits a notice — `⚠ degraded: tier N unavailable — ran tier 0` — on both the PR
comment and the Actions step summary. Never a silent under-delivery.

## Suppression

To accept an untested unit deliberately, annotate it in the diff:

```text
// canary:allow-untested <reason>
```

A suppressed finding is cleared from the `gate: hard` exit calculation but stays
**visible** in the comment (labeled `suppressed`), so the decision is auditable
rather than hidden.

## Adjudication

Your 👍/👎 does something.

React on the guardian's sticky comment to adjudicate its findings:

- **👍 (thumbs-up)** — the finding was right (true positive).
- **👎 (thumbs-down)** — the finding was wrong (false positive).

On the next `pr-check` run for that PR the guardian reads the reactions back off
its own comment and persists an adjudication record to `.harness/analyses/` (one
record per PR, latest reaction state; you can also sweep explicitly with
`canary guardian collect-adjudications --repo o/r --pr N`). One vote per user;
bots are excluded; a user who reacted both ways is dropped as contradictory. No
reaction means **neutral** — it is never counted as either verdict.

Attribution is **whole-comment**: one sticky comment carries all findings, so a
reaction adjudicates the run rather than a single finding — except when the
comment shows exactly one finding, which the reaction is attributed to directly.
(Per-finding comments were rejected as a worse artifact: N comments per PR.)

The verdicts feed the promotion evidence:

```bash
canary guardian precision          # TP / (TP + FP), with its sample size
canary guardian precision --json   # machine-readable; precision null = unknown
```

With **zero** adjudications the report says `unknown — no adjudications yet`; an
empty sample is an absent measurement, never a perfect score. When there is
data, the sample size rides alongside the number — reviewers self-select into
reacting, so treat it as a signal, not ground truth.

## Soft → hard promotion

The gate starts **soft** and earns its way to **hard** — do not flip a repo to
`hard` before the baseline has proven itself there. Promotion is earned by
reviewer adjudication feeding `precision = TP / (TP + FP)` (see
[Adjudication](#adjudication) above); `canary guardian harden-gate` surfaces the
measured precision — or an honest `unknown` — in its readiness output.

- **`gate: soft` (default).** The guardian always exits `0`. Findings are
  advisory: they post to the PR and emit an analysis, but never block a merge.
  Run here until the team trusts the findings on real PRs.
- **`gate: hard`.** The CLI exits non-zero when an unaddressed `critical`/`high`
  `untested-new-code` finding remains — where _addressed_ means either a
  covering test was added in the same diff (the finding no longer reproduces on
  re-run) or an explicit `// canary:allow-untested` suppression.

### What severity means

Severity is what `gate: hard` filters on, so it has to discriminate. Only the
**coverage-verified** tier is graded, because only that tier knows which lines
ran — the graph and heuristic tiers can say a unit is unreached but not how much
of it is, and a spread invented from that would be noise dressed as ranking.

| Severity   | Coverage-verified finding                                            |
| ---------- | -------------------------------------------------------------------- |
| `critical` | 20+ uncovered lines **and** 80%+ of the unit's coverable lines unhit |
| `high`     | 5+ uncovered lines **or** 50%+ of the coverable lines unhit          |
| `medium`   | a handful of unhit lines in an otherwise-tested change               |

The share is measured against **coverable** lines — the changed lines the report
could speak to at all — not every changed line ([#655]). On a new file that is
largely imports, type declarations and blanks, those two denominators differ by
an order of magnitude, and dividing by the larger one drives every share toward
zero. Where the count is unknown the added-line count is used instead.

Graph-verified findings are always `high`; heuristic findings are always
`medium`. Both unknowns escalate rather than downgrade: a coverage-verified
finding that carries no line numbers, or a unit whose added-line count cannot be
determined, is graded as though the gap were total. An absent measurement is
never allowed to read as a low score.

Before this grading existed, every coverage-verified finding was `high` — so a
`critical`/`high` gate was exactly "block on any coverage-verified finding", and
a reviewer facing 68 findings had no way to tell which one mattered ([#553]).

[#553]: https://github.com/bop-clocktower/canary/issues/553
[#655]: https://github.com/bop-clocktower/canary/issues/655
[#657]: https://github.com/bop-clocktower/canary/issues/657
[#738]: https://github.com/bop-clocktower/canary/issues/738
[#747]: https://github.com/bop-clocktower/canary/issues/747
[#761]: https://github.com/bop-clocktower/canary/issues/761

Promotion is **per-repo** and has two parts: the **exit gate** (`gate: hard` in
config, which makes `canary guardian pr-check` exit non-zero on an unaddressed
finding) and the **required status check** in branch protection (what actually
blocks the merge button). Until the check is required, `gate: hard` blocks the
guardian's own exit code but not the merge.

Register the required check with:

```bash
canary guardian harden-gate                 # dry-run: shows the plan + manual steps
canary guardian harden-gate --apply         # register it (needs an admin token)
```

It requires the guardian's status-check context (`guardian` by default; pass
`--check` if your workflow job differs) on the branch, **merging** into any
existing protection rather than replacing it — it only ever creates fresh
protection when the branch is genuinely unprotected, so a branch that already
requires reviews keeps them. Two safety rails:

- **Phantom-context guard.** Before registering, it verifies the context is one
  a recent commit actually reported. Requiring a check that never runs would
  leave every PR permanently un-mergeable, so if the context isn't found it
  refuses and lists the real ones (override with `--force` only if you know the
  context will report). Confirm the exact name from a recent PR's checks.
- **Fail-loud.** No admin scope, an unsupported plan, a bad token, or a network
  error → it prints the exact manual steps and exits non-zero, never a silent
  no-op.

Then set `gate: hard` in config, confirm a few PRs behave, and you're promoted.

## Related

- [Harness + Canary Integration Guide](harness-canary-integration.md) —
  disambiguation matrix (guardian vs `canary-test-pipeline` vs harness gates)
- [ADR 0007](../knowledge/decisions/0007-guardian-agent-capability-boundary.md)
  — agent capability boundary
- [ADR 0008](../knowledge/decisions/0008-guardian-canary-owned.md) —
  canary-owned ownership stance
- `docs/changes/canary-pr-guardian/proposal.md` — full spec and success criteria
