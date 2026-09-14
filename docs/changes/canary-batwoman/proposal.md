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

### D7 — The renderer takes a persona, it does not invent a voice

Output is rendered through canary's existing persona registry
(`ts/src/data/personas/registry.json`, resolved by `resolvePersona()` in
`ts/src/core/persona.ts`) rather than through a bespoke format.

| Persona  | Depth  | Batwoman's report becomes                                     |
| -------- | ------ | ------------------------------------------------------------- |
| `sdet`   | terse  | Summary line plus bare rows; no explanation clauses           |
| `junior` | brief  | Full sentences with the "why it is dormant" clause            |
| `manual` | guided | Numbered next steps ("1. Apply `refresh-baseline` to a PR …") |

**Why:** the registry already exists and is already consumed for exactly this —
`canary-edge-case-discovery` scales explanation depth to user level. A second,
private notion of "readable" inside batwoman would drift from it immediately.
`resolvePersona()` accepts an injected registry, so every register stays
unit-testable without touching disk.

**The invariant gets harder, deliberately.** D5's no-success-token rule now has
to hold across three registers instead of one, and terse output is where a bare
`✓` is most tempting. That is an argument for wiring personas in now: designing
one renderer that takes a register as input is cheaper than retro-fitting the
invariant across three later.

`ResolvedPersona` carries `source` (`explicit` / `detected` / `fallback`) and a
one-line `reason`. Batwoman prints which register it used and why, so a reader
who gets terse output when they wanted guided output can see the cause instead
of assuming detail was missing.

### D8 — The CI workflow is generated by a persona, not hand-written

Rather than authoring `.github/workflows/batwoman.yml` by hand, batwoman ships a
harness persona declaring `triggers` and `outputs: { ci-workflow: true }`, and
the workflow is generated from it.

**Why:** a hand-written workflow drifts from its intent the moment a trigger
changes, and this repo already carries a whole guard suite for workflows that
quietly stopped matching what they claimed to do
(`ts/test/workflow-false-green.test.ts`, 97 assertions). Generating from a
declaration keeps the trigger and the file in agreement by construction.

**[AMENDED 2026-09-09 — BW-C3]** The workflow is **hand-written**, and the
persona declares `outputs.ci-workflow: false`. `harness persona sync-workflows`
emits a job whose only step is `npx harness <command>` under a pnpm install;
batwoman is a _canary_ CLI subcommand taking `--issue N`, and this repo uses npm
for `ts/`, so generation would produce a workflow calling a command that does
not exist. Two further facts found the same way: the schema has no `push` event
(the four are `manual`, `on_commit`, `on_pr`, `scheduled`, and `on_commit` on
`main` is what D8's "push" means), and a persona with `ci-workflow: true` but no
`commands:` block generates nothing while `--check` still reports
`OK — 0 persona workflows are up to date`.

The requirement survives without the mechanism: the trigger is declared once in
the persona, and `ts/test/batwoman-workflow-drift.test.ts` asserts the committed
workflow still matches it. Recorded in full as ADR 0016.

**[IMPORTANT]** Harness personas and canary personas are unrelated concepts
sharing a word: a harness persona binds skills to triggers and generates
surfaces; a canary persona selects an output register for a human reader.
Batwoman uses both, for different jobs. The ADR must state this plainly — the
collision is confusing enough that a future reader will otherwise assume D7 and
D8 are the same mechanism.

## Technical design

### Verdict model

```ts
type ExerciseStatus =
  | 'exercised' // positive evidence it ran after the merge
  | 'not-exercised' // positive evidence it did NOT run
  | 'abstain' // a probe matched but could not decide
  | 'no-probe' // no probe matched this file
  | 'not-applicable'; // no execution semantics (docs, changelog)

/** A verdict sentence guaranteed non-empty: the only constructor is explain(). */
type Explanation = string & { readonly [brand]: true };
declare function explain(text: string): Explanation; // throws on '' or blank

interface VerdictFields {
  readonly file: string;
  /** Human sentence for the report. Never a code, never empty. */
  readonly explanation: Explanation;
}

/** A verdict that claims the file did or did not run. Evidence is required. */
interface ClaimedVerdict extends VerdictFields {
  readonly status: 'exercised' | 'not-exercised';
  readonly evidence: string;
}

/** A verdict that claims nothing: abstain, no-probe, not-applicable. */
interface UnclaimedVerdict extends VerdictFields {
  readonly status: 'abstain' | 'no-probe' | 'not-applicable';
  /** What was read, when anything was. Absent for no-probe by definition. */
  readonly evidence?: string;
}

type ExerciseVerdict = ClaimedVerdict | UnclaimedVerdict;
```

`abstain` and `no-probe` are deliberately distinct. The first means a probe
looked and could not tell (report it, investigate it). The second means nothing
looked (a registry gap, fixable by adding a probe). Collapsing them would hide
which of the two a given file suffers from.

**[AMENDED 2026-08-24 — BW-C1]** `explanation` was `string`. Phase 1 review
found that an empty one rendered as a bare file path under a status heading, in
all three registers, and that the test named to prevent it asserted only that
the file name and the count survived — both of which the defect preserved.
Rendering an explicit gap line was considered and rejected: it makes the
renderer responsible for a defect it cannot fix, and leaves a probe free to ship
the gap. `Explanation` is therefore branded, so the value cannot be constructed
without passing `explain()`, and an empty sentence is a compile error at every
call site rather than a rendering artefact at the far end.

**[AMENDED 2026-08-24 — BW-I4]** This supersedes `evidence?: string` on every
status. `exercised` and `not-exercised` now require `evidence`; the three
non-answers keep it optional. **A success claim with nothing behind it is the
exact defect batwoman exists to detect, so permitting it in batwoman's own type
is self-undermining.** `not-exercised` is held to the same bar because a
negative claim sends a human off to run something and owes them the reason.
`no-probe` cannot carry evidence by definition — nothing looked — and `abstain`
may or may not, depending on whether the probe got as far as reading anything.

Both amendments are enforced at the type boundary and again at `probeFile`'s
exit, because a probe can arrive from JavaScript, from a plugin, or from a
`JSON.parse`, where the type guarantees nothing. A probe whose answer fails
either check is reported as an `abstain` naming the probe: something looked, and
its answer cannot be trusted.

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

The renderer takes a `ResolvedPersona` and emits prose, not codes. `--json`
produces the machine shape for the CI wrapper and is persona-independent.

The sample below is the `junior` register (the fallback, per the registry's
`fallback: "junior"`).

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

1. Every run prints the summary line, including runs with nothing to report,
   **in every persona register**. Terse is where a bare `✓` is most tempting;
   the rule binds hardest there.
2. No success token (`✓`, `OK`, `clean`, `passed`) appears in any output path.
3. Every `not-exercised` row carries a full-sentence explanation, never a code.
4. Every `no-probe` row names the artifact type it could not classify.
5. Counts in the summary sum to the changed-file total. A mismatch is a bug and
   is asserted as such.
6. The chosen persona and its `source` are printed, so a reader can tell a terse
   report from a truncated one.

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

  **[AMENDED 2026-09-09 — BW-C2]** Two errors of fact above, found while
  implementing Phase 3, and the abstention is narrower as a result.

  The default is **20**, not 30 (`gh run list --help`). More importantly, the
  rationale does not hold: `gh run list` returns runs **newest-first** (verified
  against this repo's own history), so every run beyond the page is older than
  every run in it. For a qualifying run to hide outside the window, the oldest
  fetched run would have to postdate `mergedAt` — and that same condition puts a
  qualifying run _inside_ the window, where it is found. **A dropped-off page
  cannot conceal a run after the merge**, so abstaining whenever the page fails
  to span `mergedAt` would report ignorance the tool does not have, which is its
  own false report.

  What ships instead: the port still requests an explicit limit and still
  reports `complete`, and the probe abstains on the one window that genuinely
  says nothing — **empty and incomplete**, an absence of evidence rather than
  evidence of absence. `RunHistory.complete` is kept precisely so this argument
  stays checkable: if the ordering guarantee ever changes, `windowIsBlind` is
  the single function that has to change with it.

- **File deleted by the closing PR.** There is nothing to exercise, and the file
  no longer exists to classify. Reported as `not-applicable` with the reason
  "deleted by this change".
- **A PR closing more than one issue.** Batwoman reports one section per closed
  issue over the same changed-file set, rather than picking one arbitrarily.

## Integration Points

### Entry Points

- New CLI subcommand `canary batwoman --issue N [--json]` in the commander-based
  TS CLI.
- New skill `agents/skills/claude-code/canary-batwoman/SKILL.md`.
- New harness persona declaring the `push` trigger and
  `outputs: { ci-workflow: true }`; `.github/workflows/batwoman.yml` is
  generated from it rather than authored by hand (D8).

### Registrations Required

- CLI subcommand registration in the commander root.
- **Both** `entryPoints` arrays in `harness.config.json` (lines 153 and 204).
  New `ts/src` modules trip the entropy ratchet because the analyzer cannot
  follow `./x.js` specifiers; the two arrays must be updated together. The
  ceiling is never raised to accommodate a new module.
- Skill listed in the plugin manifest so `Skill surface integrity` passes.
- An `unexercised` repository label, created before the workflow can apply it.
- No change to `ts/src/data/personas/registry.json` — batwoman consumes the
  three existing registers and adds none. If a register turns out to be a poor
  fit, that is a registry change with its own blast radius across every skill
  that reads it, not a batwoman change.

### Documentation Updates

- `AGENTS.md` — add batwoman to the skill inventory, and note it as the first
  detector that requires network access, and why that is stated as a property
  rather than a tier.
- `README.md` — skill list.
- `CHANGELOG.md` — under Unreleased.

### Architectural Decisions

Three decisions warrant standalone ADRs (the count below said "two" and listed
three; corrected 2026-09-09):

- **D2 (the capability axis)** — it departs from a no-network property four
  shipped skills share, and it declines to express that as a tier. The ADR
  should define the three independent axes (determinism, network, agent) and
  record that "tier" is ambiguous in this repo, so the next skill does not
  re-litigate it.

  **[RESOLVED 2026-09-09]** Already written: **ADR 0015 — Skill capability is
  three axes, not a tier** (2026-09-03, #753). It defines exactly these axes and
  names this skill, under its pre-rename name `canary-manhunter`, as the
  motivating example. Phase 5 writes no second ADR for D2; it corrects that
  stale name and records that batwoman is the first shipped skill on the network
  axis.

- **D7/D8 (the two meanings of "persona")** — harness personas bind skills to
  triggers; canary personas select an output register. Batwoman is the first
  thing here to use both at once, and the shared word will mislead anyone
  reading the code cold.
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
8. The no-success-token rule (criterion 3) shall be asserted separately for each
   persona register, not once against the default.
9. When no persona is explicitly chosen, batwoman shall render the registry's
   declared fallback and print that it did so, with the `source` and `reason`
   from `ResolvedPersona`.
10. The CI workflow shall be generated from the persona declaration, and a test
    shall assert the committed workflow matches what the declaration generates —
    a drifted workflow is a failure, not a formatting difference.
11. Every `not-exercised` and `abstain` row shall render a complete sentence
    naming both the observation and its cause, asserted by test against the
    renderer's output rather than its inputs. _(Covers the "reads like a human
    wrote it" goal, which criteria 1-7 otherwise leave untested.)_
12. An empty explanation shall be a **compile error**, not a rendering artefact,
    and `probeFile` shall reject one arriving from outside TypeScript. Asserted
    by compiling snippets against the real source, not by a `@ts-expect-error`
    comment — `ts/tsconfig.json` includes only `src`, so no gate compiles the
    test tree.
13. An `exercised` or `not-exercised` verdict shall be unable to omit its
    evidence, asserted the same way.
14. Every line of every rendered report shall be at most 78 columns, asserted
    for **all three registers** over a fixture set that includes a path and an
    evidence command long enough to overflow the limit unwrapped.

## Implementation Order

**Phase 1 — Core (no network).** Verdict types, `ExerciseProbe` interface,
registry, and the persona-aware renderer. TDD against fixtures, with an injected
`PersonaRegistry` so no register touches disk. Criteria 2, 3, 5, 7, 8, 9, 11
provable here.

**Phase 2 — Probes.** `workflow`, `workflow-script`, `no-execution`, including
`on:`-block parsing for trigger explanations. Criterion 1's logic provable
against a fixture built from #749's real data.

**Phase 3 — The gh adapter.** `RunHistoryPort` over `gh run list`, plus the
failure path. Criterion 4.

**Phase 4 — CLI surface.** `canary batwoman` with `--issue` and `--json`. First
end-to-end run against the live #749.

**Phase 5 — Skill and CI.** `SKILL.md`, the harness persona declaration, the
generated workflow plus its drift assertion, the `unexercised` label, and every
registration in Integration Points. Criteria 6 and 10.
