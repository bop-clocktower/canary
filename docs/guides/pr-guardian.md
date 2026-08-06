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
  `assert`, chai `.should`, `pytest.raises`, `assert_*` helpers) all count as
  asserting, and a rename that adds only a signature line is ignored. Known
  limits — it scores a file's _added lines as a whole_ (so if a diff adds one
  asserting and one assertion-free test to the same file, neither is flagged),
  and a test whose only check is a custom helper _not_ named `assert*` (e.g.
  `verify_response(resp)`) may be flagged; since the finding is advisory, the
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

The `schemaVersion` bump is the first since 1.0 and is purely additive: every
1.0 field keeps its name, type, and meaning. Consumers should compare the
**major** component (`1`) rather than the whole string — a strict `=== "1.0"`
check rejects a record it can read perfectly well.

The minor bumps when an added field carries a _verifiability_ claim — one whose
absence would otherwise read as good news. `coverage` is such a field: missing,
it looks like "coverage was fine" when it actually means "this producer could
not say". So `>= 1.1` is what licenses a reader to trust the `coverage` block.
Fields that are merely more detail do not move it.

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

| Severity   | Coverage-verified finding                                        |
| ---------- | ---------------------------------------------------------------- |
| `critical` | 20+ uncovered lines **and** 80%+ of the unit's added lines unhit |
| `high`     | 5+ uncovered lines **or** 50%+ of the added lines unhit          |
| `medium`   | a handful of unhit lines in an otherwise-tested change           |

Graph-verified findings are always `high`; heuristic findings are always
`medium`. Both unknowns escalate rather than downgrade: a coverage-verified
finding that carries no line numbers, or a unit whose added-line count cannot be
determined, is graded as though the gap were total. An absent measurement is
never allowed to read as a low score.

Before this grading existed, every coverage-verified finding was `high` — so a
`critical`/`high` gate was exactly "block on any coverage-verified finding", and
a reviewer facing 68 findings had no way to tell which one mattered ([#553]).

[#553]: https://github.com/bop-clocktower/canary/issues/553

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
- [ADR 0007](../adr/0007-guardian-agent-capability-boundary.md) — agent
  capability boundary
- [ADR 0008](../adr/0008-guardian-canary-owned.md) — canary-owned ownership
  stance
- `docs/changes/canary-pr-guardian/proposal.md` — full spec and success criteria
