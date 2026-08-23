# canary-batwoman — proving a closed issue's fix was actually exercised

**Status:** proposed **Keywords:** closure-verification, exercise-probe,
abstention, post-merge, run-history, advisory-gate

## Overview

GitHub closes an issue when a merged PR's body contains `Closes #N`. That is a
**string match with no denominator** — nothing checks that the fix works, and
nothing checks that the fix ever ran. The issue moves to `CLOSED` on the
strength of a keyword.

`canary-batwoman` audits closed issues and reports, per changed file, whether
that artifact has **executed since the fix merged**. It never asserts the fix is
correct — only whether the code has run at all. Advisory in v1: it labels,
comments, and reports. It never fails a job and never reopens an issue.

### The founding case

canary#749 fixed a false-green in `.github/workflows/refresh-arch-baseline.yml`.
It merged as `1e0c05b` and auto-closed on the `Closes` keyword. Verified after
the fact:

- 11 script unit tests pass
- 97 static workflow assertions pass
- The workflow itself **has not run since 2026-08-10** — twelve days before the
  fix merged. It is label-triggered, so it stays dormant until a maintainer
  applies `refresh-baseline`.

Every gate the repo owns read that as done. The fix is real and well-tested; its
end-to-end path is unproven. That distinction is what batwoman exists to make
visible.

Compounding it, #749 recorded a second mechanic: `check-arch` resolves the
baseline from the **base branch**, so a refresh workflow's effect is
unobservable on the PR that changes it. The class of bug where "verified" and
"exercised" diverge is therefore structural here, not incidental.

### Goals

1. Report, for each file a closing PR changed, whether it has executed since the
   merge.
2. Make the denominator unavoidable — never report a pass over a subset as a
   pass over the whole.
3. Name what cannot be assessed, as an enumerable gap rather than silence.
4. Read like a sentence a human wrote, not a status code.

### Non-goals

- **Asserting correctness.** Batwoman proves execution, never behavior.
- **Blocking merges.** Advisory only. A strict mode is deliberately deferred
  until the advisory volume has been triaged — the precedent is `dogfood.yml`,
  which shipped its advisory jobs first and ratcheted afterward (six jobs as of
  this writing: test-quality, doctor, node-floor, skill-surfaces, fleet-health,
  katana).
- **Reopening issues.** Batwoman reports; a human decides.
- **Execution telemetry.** Batwoman reads evidence that already exists. It does
  not instrument anything to create new evidence.

## Assumptions

- **Runtime:** Node.js >= 20, matching the repo's declared floor.
- **`gh` is on PATH and authenticated** with read access to the repository.
  Batwoman does not manage credentials; an unauthenticated `gh` is a
  `RunHistoryPort` failure and takes the abstain path.
- **The repository is hosted on GitHub.** Run history has no equivalent on a
  mirror or a bare remote, so batwoman abstains wholesale there rather than
  reporting clean.
- **Merges are squashes.** This repo squash-merges, so the closing commit is not
  an ancestor of the PR branch. Probes therefore compare by timestamp, never by
  commit ancestry.

## Decisions made

### D1 — Skill plus thin CI wrapper, not a workflow alone

All logic lives in `ts/src`, exercised by a CLI subcommand and a skill. The
workflow is a thin advisory caller.

**Why:** a workflow-only detector could only ever watch the future, leaving #749
— the case that motivated it — permanently unexamined. Putting the logic in
`ts/` also places it where the four gates actually run. This follows
`canary-pr-guardian`, which already splits logic from its CI invocation.

### D2 — It requires the network, and says so in plain words

The detector family (`cassandra`, `savant`, `blackhawk`, `katana`) each declare
themselves deterministic with no LLM and **no network**. Batwoman needs GitHub
Actions run history, so it cannot claim that. Its `SKILL.md` states the
difference directly: _deterministic, no LLM, **requires network**._

**Deliberately not expressed as a tier.** "Tier-1" already carries two
contradictory meanings in shipped skills — `canary-savant` uses it for its
deterministic static floor, `canary-pr-guardian` for its LLM-assisted audit —
and nothing authoritative defines the scale. Adding a third meaning would make
the vocabulary worse while appearing to make it precise.

**Why:** the properties that actually matter here are independent, not points on
one line. A skill can be deterministic or not, need the network or not, and
invoke an agent or not, in any combination. Batwoman is deterministic,
network-requiring, agent-free — a sentence that says more than any tier number
and cannot be misread.

### D3 — A probe registry, not a monolithic classifier

Each artifact type gets an `ExerciseProbe` that declares what it matches, what
evidence it reads, and when it abstains. Unmatched files produce a **named**
`NO PROBE` row, not silence.

**Why:** the gaps become countable. This is the same move the no-silent-
abstention registry (#508) made — its 24 rows work precisely because the
uncovered cases are enumerable rather than assumed. A monolithic classifier
would have to be reopened and reshaped for every new artifact type.

### D4 — Confidence scores are rejected

An earlier option scored every artifact type by confidence. Rejected.

**Why:** a confidence number attached to a guess reads as evidence. "73%
confident this module's fix path ran" is less honest than "I have no probe for
this," because the first invites a reader to round it up. Three discrete
statuses plus an explicit no-probe row carry strictly more information than a
float.

### D5 — The summary line always prints every count

The renderer has no success-only path. There is no `✓ clean` token anywhere in
its output. Every run ends with one column per status — including the two that
mean batwoman could not decide.

**Why:** a detector covering two of seven changed files that printed "0
unexercised ✓" would be a pass over a denominator of 2 presented as a pass over
7 — the precise defect batwoman was built to catch, committed by batwoman.

### D6 — Network access is confined to one port

All run-history access goes through a `RunHistoryPort` interface. The real
implementation shells out to `gh`; tests inject a fixture.

**Why:** it keeps every decision path unit-testable offline, so the detector's
_judgment_ is provable even though its _evidence_ is not. It also means the
network dependency from D2 lives at exactly one seam.

## Technical design

### Verdict model

```ts
type ExerciseStatus =
  | 'exercised' // positive evidence it ran after the merge
  | 'not-exercised' // positive evidence it did NOT run
  | 'abstain' // a probe matched but could not decide
  | 'no-probe' // no probe matched this file
  | 'not-applicable'; // no execution semantics (docs, changelog)

interface ExerciseVerdict {
  readonly file: string;
  readonly status: ExerciseStatus;
  /** Human sentence for the report. Never a code. */
  readonly explanation: string;
  /** What was read to decide. Absent for no-probe. */
  readonly evidence?: string;
}
```

`abstain` and `no-probe` are deliberately distinct. The first means a probe
looked and could not tell (report it, investigate it). The second means nothing
looked (a registry gap, fixable by adding a probe). Collapsing them would hide
which of the two a given file suffers from.

### The probe interface

```ts
interface ExerciseProbe {
  readonly id: string;
  /** Human noun phrase used in NO PROBE rows: "test file", "config". */
  readonly artifact: string;
  matches(file: string): boolean;
  probe(file: string, ctx: ExerciseContext): Promise<ExerciseVerdict>;
}

/** Header data for the report. Probes never read this. */
interface ClosureHeader {
  readonly issue: number;
  readonly mergeSha: string;
  readonly mergeSubject: string;
  readonly mergedAt: Date;
}

interface ExerciseContext {
  readonly mergedAt: Date;
  readonly repo: string;
  readonly runs: RunHistoryPort;
  /** Repo root, for static resolution (e.g. which workflow calls a script). */
  readonly root: string;
}

interface RunHistoryPort {
  runsForWorkflow(workflowPath: string): Promise<WorkflowRun[]>;
}

interface WorkflowRun {
  readonly createdAt: Date;
  readonly conclusion: string | null;
}
```

### Probes shipped in v1

| Probe             | Matches                                           | Decides by                                                                                                                                |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`        | `.github/workflows/*.yml`                         | A run exists with `createdAt` after `mergedAt`. Also reads the `on:` block to explain _why_ a dormant workflow is dormant.                |
| `workflow-script` | `scripts/*.mjs`                                   | Greps `.github/workflows/` for the basename, then delegates to `workflow` for each referencing file. Abstains when nothing references it. |
| `no-execution`    | `**/*.md`, `CHANGELOG.md`, known config manifests | Returns `not-applicable` without reading anything.                                                                                        |

Everything else yields `no-probe`, naming the artifact type it could not
classify. `ts/src/**`, `ts/test/**`, and `agents/skills/**` are all expected
`no-probe` rows in v1 — that is the honest state, and the registry makes it
countable.

Reporting the trigger type is not decoration. #749's workflow is dormant
_because_ it is label-gated, and a reader who is told only "has not run" will
reasonably assume something is broken. The `on:` block turns a bare fact into an
explanation.

### Human-readable output

The default renderer emits prose, not codes. `--json` produces the machine shape
for the CI wrapper.

```text
canary batwoman — canary#749

  Closed by  1e0c05b  fix(ci): make the refresh-baseline label refresh the baseline
  Merged     2026-08-22 17:34 UTC (1 day ago)

  NOT EXERCISED — 2 of 7 changed files

    .github/workflows/refresh-arch-baseline.yml
      Last ran 2026-08-10, twelve days before this fix merged. It is
      triggered only by the `refresh-baseline` label, so it stays
      dormant until a maintainer asks for a refresh.

    scripts/refresh-arch-baseline.mjs
      Runs only from refresh-arch-baseline.yml, above, so it has not
      run either.

  NO PROBE — 3 files
    batwoman has no way to tell whether these ran.
      ts/test/refresh-arch-baseline.test.ts    no probe for: test file
      ts/test/workflow-false-green.test.ts     no probe for: test file
      harness.config.json                      no probe for: config

  NOT APPLICABLE — 2 files
    AGENTS.md, CHANGELOG.md — nothing to execute.

  ──────────────────────────────────────────────────────────────
  7 changed · 0 exercised · 2 not exercised · 0 abstained · 3 no probe · 2 n/a
```

Renderer rules, enforced by test:

1. Every run prints the summary line, including runs with nothing to report.
2. No success token (`✓`, `OK`, `clean`, `passed`) appears in any output path.
3. Every `not-exercised` row carries a full-sentence explanation, never a code.
4. Every `no-probe` row names the artifact type it could not classify.
5. Counts in the summary sum to the changed-file total. A mismatch is a bug and
   is asserted as such.

### Failure behavior

When `RunHistoryPort` throws or `gh` is unavailable, batwoman reports the
failure and marks affected files `abstain`. It does not fall back to reporting
them clean. Per the repo's standing rule, cannot-verify is a finding.

Three further cases, each resolving to `abstain` rather than a verdict:

- **Truncated run history.** `gh run list` returns 30 results by default. If the
  fetched page does not reach back past `mergedAt`, the absence of a qualifying
  run is indistinguishable from truncation. `RunHistoryPort` shall request an
  explicit limit and report whether the window actually spans `mergedAt`; if it
  does not, the probe abstains. Inferring "never ran" from a truncated list is
  the same false-negative shape batwoman exists to catch.
- **File deleted by the closing PR.** There is nothing to exercise, and the file
  no longer exists to classify. Reported as `not-applicable` with the reason
  "deleted by this change".
- **A PR closing more than one issue.** Batwoman reports one section per closed
  issue over the same changed-file set, rather than picking one arbitrarily.

## Integration Points

### Entry Points

- New CLI subcommand `canary batwoman --issue N [--json]` in the
  commander-based TS CLI.
- New skill `agents/skills/claude-code/canary-batwoman/SKILL.md`.
- New advisory workflow `.github/workflows/batwoman.yml`, triggered on push to
  `main`.

### Registrations Required

- CLI subcommand registration in the commander root.
- **Both** `entryPoints` arrays in `harness.config.json` (lines 153 and 204).
  New `ts/src` modules trip the entropy ratchet because the analyzer cannot
  follow `./x.js` specifiers; the two arrays must be updated together. The
  ceiling is never raised to accommodate a new module.
- Skill listed in the plugin manifest so `Skill surface integrity` passes.
- An `unexercised` repository label, created before the workflow can apply it.

### Documentation Updates

- `AGENTS.md` — add batwoman to the skill inventory, and note it as the first
  detector that requires network access, and why that is stated as a property
  rather than a tier.
- `README.md` — skill list.
- `CHANGELOG.md` — under Unreleased.

### Architectural Decisions

Two decisions warrant standalone ADRs:

- **D2 (the capability axis)** — it departs from a no-network property four
  shipped skills share, and it declines to express that as a tier. The ADR
  should define the three independent axes (determinism, network, agent) and
  record that "tier" is ambiguous in this repo, so the next skill does not
  re-litigate it.
- **D3 (probe registry and the abstain/no-probe split)** — it establishes a
  reusable pattern, and the two-status distinction is subtle enough to be
  "simplified" away by a later contributor who does not know why it exists.

### Knowledge Impact

- The concept pair **verified vs exercised** — a fix can be fully tested and
  never have run.
- The **closure claim** as an auditable artifact, alongside the existing
  vacuous-test and vanished-test concepts.
- The probe-registry-with-named-gaps pattern, generalizing #508's approach.

## Success Criteria

1. Against a **frozen fixture** capturing canary#749's real state at `1e0c05b`
   (changed files, merge timestamp, and the workflow's run history as of
   2026-08-23), batwoman shall report
   `.github/workflows/refresh-arch-baseline.yml` and
   `scripts/refresh-arch-baseline.mjs` as `not-exercised`, and shall explain the
   label trigger. _(The founding acid test — it must catch its own origin.)_ The
   fixture is frozen deliberately: once that workflow does eventually run, a
   live assertion would flip to `exercised` and the regression test would rot
   into a false failure.
2. When a changed file matches no probe, batwoman shall emit a `no-probe` row
   naming the artifact type, and shall never count that file as exercised.
3. Every output path shall print the summary line with a column for each of the
   five statuses plus the changed-file total, and no output path shall contain a
   success token. `abstain` and `no-probe` shall never be folded into a derived
   "assessed" figure — a file batwoman could not decide about must not be
   counted among those it decided.
4. If `RunHistoryPort` fails, batwoman shall mark affected files `abstain` and
   report the failure; it shall not report them clean.
5. All probe and renderer logic shall pass unit tests with a fixture
   `RunHistoryPort` and no network access.
6. The workflow shall exit 0 under every verdict, including `not-exercised`.
7. The summary counts shall sum to the changed-file total, asserted by test.
8. Every `not-exercised` and `abstain` row shall render a complete sentence
   naming both the observation and its cause, asserted by test against the
   renderer's output rather than its inputs. _(Covers the "reads like a human
   wrote it" goal, which criteria 1-7 otherwise leave untested.)_

## Implementation Order

**Phase 1 — Core (no network).** Verdict types, `ExerciseProbe` interface,
registry, and the renderer. TDD against fixtures. Criteria 2, 3, 5, 7 provable
here.

**Phase 2 — Probes.** `workflow`, `workflow-script`, `no-execution`, including
`on:`-block parsing for trigger explanations. Criterion 1's logic provable
against a fixture built from #749's real data.

**Phase 3 — The gh adapter.** `RunHistoryPort` over `gh run list`, plus the
failure path. Criterion 4.

**Phase 4 — CLI surface.** `canary batwoman` with `--issue` and `--json`. First
end-to-end run against the live #749.

**Phase 5 — Skill and CI.** `SKILL.md`, the advisory workflow, the `unexercised`
label, and every registration in Integration Points. Criterion 6.
