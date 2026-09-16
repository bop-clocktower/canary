# Pedagogical reasoning: a decision trace for `canary recommend` (#342)

**Keywords:** reasoning, explanation-depth, persona, recommender, classifier,
decision-trace, audience, abstention

> **Status: Spec only — not signed off.** No human has reviewed this proposal.
> Every fork below (F1-F8) carries a recommended default chosen by the authoring
> lane without asking; each is an open question until a human accepts or
> overrides it. The document contains no code, no skill files and no CLI wiring.
> The evidence is in [`survey.md`](survey.md).

## Overview

Issue #342 was written before personas existed. Since then #341 and #462 shipped
the parts the issue treated as blockers: a user-level signal, a persona registry
whose `reasoning` flag already encodes "off for SDET, on for manual/unknown",
and an explanatory fallback that stores nothing about the user. What does not
exist is anything worth saying when reasoning is on. `canary recommend` prints a
`Reasoning:` list today, but it is copied registry prose about the framework,
not the facts that produced the decision (survey section 3).

This proposal cuts the smallest slice that gives #342 its user value: make the
classifier and recommender record **why** they decided, and render that trace
from `canary recommend`, gated by the existing persona model.

### Goals

1. The classifier reports which rule matched (the keyword and the category) in
   addition to `test_type` and confidence.
2. The recommender reports each ranking factor it applied to the chosen
   candidate and to the first alternative: prompt hint, `preferred` status,
   language filter applied or fell through, license demotion.
3. `canary recommend --reasoning` prints that trace in a separate section after
   the recommendation; `--json` carries it in a new `trace` field.
4. Without the flag, human output is decided by the resolved persona's
   `reasoning` boolean (F3).
5. Every trace line is a fact the engine used, never a generated justification.

### Out of scope

- Why a test user was selected. Canary makes no such decision; the consumer's
  `user_catalog_skill` does (survey section 4).
- Why a coverage skill was chosen (skill dispatch). Follow-up once the trace
  shape is proven.
- A second audience model, a new config store, or persisting a skill level.
- Persona consumption by skills other than `canary-edge-case-discovery`.
- LLM-written explanations of any kind.

## Forks for the human

Each fork records where the brainstorming method would have asked. The default
applies until overridden.

| #   | Question                                   | Options                                                                                                            | Recommended default                                           | Reason                                                                                                                                                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Build a reasoning audience model, or reuse | (a) new `reasoning` config (`auto/on/off`) as in the issue; (b) reuse the persona `reasoning` flag plus a CLI flag | **(b) reuse personas**                                        | The roadmap row's stated risk is "a second audience model beside the first". The registry already encodes the issue's `auto` default as data.                                           |
| F2  | Slice scope                                | (a) `recommend` only; (b) `recommend` plus MCP `analyze_file`; (c) every emitting surface                          | **(a) `recommend` only**                                      | It is the one surface that already prints a `Reasoning:` section, so the change is to its content, not a new surface. MCP follows once the trace shape holds.                           |
| F3  | Default when no flag is passed             | (a) always print trace; (b) persona decides (fallback `junior` prints it); (c) never print without the flag        | **(b) persona decides**                                       | Matches the #342 default and the owner's "err explanatory" call. An SDET resolved with enough signal gets terse output; `--no-reasoning` is the off-switch.                             |
| F4  | Flag name                                  | (a) `--reasoning` / `--no-reasoning`; (b) `--explain`; (c) `--level <persona>` as in edge-case-discovery           | **(a) `--reasoning`, plus accept `CANARY_PERSONA`**           | The issue and both triage comments name `--reasoning`. `--level` changes depth, a different axis; conflating them repeats the drift #462 removed.                                       |
| F5  | What replaces today's registry prose       | (a) keep prose, append trace; (b) replace prose with trace; (c) prose under `--json` only                          | **(a) keep prose under "About", trace under "Why this pick"** | Prose is still useful description, and scripts reading `reasoning` in JSON must not break. The trace is additive (`trace` field).                                                       |
| F6  | Silent fall-throughs                       | (a) record only applied factors; (b) also record factors that fell through (language filter matched nothing)       | **(b) record fall-throughs as named lines**                   | The language filter silently returns the unfiltered pool (`recommender.ts:109-120`). A trace that omits it teaches a confident wrong lesson: the issue's own accepted risk.             |
| F7  | Classifier confidence wording              | (a) print the number; (b) print the matched rule and mark confidence as a fixed rule weight, not a probability     | **(b) matched rule, confidence labelled "rule weight"**       | Confidences are constants per rule (`classifier.ts:186, 199`). Presenting `0.85` as calibrated confidence overstates it, the same margin-vs-probability error #712 caught in detection. |
| F8  | Tier of the change                         | (a) spec then one build PR; (b) spike first                                                                        | **(a) one build PR**                                          | No unknowns needing a spike: every factor is already computed in-process; the work is to stop discarding it.                                                                            |

### Approaches considered

1. **The issue as written: new `reasoning` config, skill-level detection,
   persistence.** Every input now exists elsewhere; building it again creates a
   second audience model. Rejected (F1).
2. **LLM-generated explanations in skills.** Cheap to write, impossible to test,
   and explanation attached to a wrong answer is more convincing than the wrong
   answer. Rejected.
3. **Engine decision trace, persona-gated rendering (chosen).** Deterministic,
   unit-testable, and a senior SDET debugging a bad pick gets the same facts via
   `--reasoning`.

## Technical design

Trace entries are plain data produced where the decision is made:

```json
{
  "trace": [
    {
      "stage": "classify",
      "factor": "keyword",
      "detail": "matched 'endpoint' -> api",
      "weight": 0.85
    },
    {
      "stage": "rank",
      "factor": "language-filter",
      "detail": "no framework matched [python]; used unfiltered pool"
    },
    {
      "stage": "rank",
      "factor": "preferred",
      "detail": "vitest is status=preferred; ranked above jest"
    }
  ],
  "persona": { "id": "junior", "source": "fallback", "reasoning": true }
}
```

- `stage` is `classify | rank | license`; `factor` is a closed enum so tests can
  assert on it.
- Human rendering: `Why this pick:` then one line per entry, then the persona
  line (`shown because persona 'junior' (fallback)`), so the user can see why
  they got the explanation and how to switch it off.
- The classifier and recommender return the trace alongside today's results;
  existing fields and ordering are unchanged.

## Integration points

### Entry points

- `canary recommend`: new `--reasoning` / `--no-reasoning` option; `trace` and
  `persona` fields in `--json`.

### Registrations required

- Option registration on the existing `recommend` command in `ts/src/cli.ts`.
- No new command, module directory, skill, or MCP tool.

### Ratchet cost (known, budget before the build PR)

This slice adds no new CLI command, `src` module or skill, which is the reason
it is scoped this way. Expected cost:

- **Perf delta:** `recommendFrameworkCmd` gains a render branch and
  `rankPool`/`applyLanguageFilter` gain trace pushes. Complexity identities on
  those functions may grow; magnitude growth is advisory, but a new function
  identity is not waivable. Keep the renderer as one new helper at most, or pay
  down an equal amount.
- **Entropy `entryPoints`:** none, if no new module is added. A separate
  `trace.ts` module would need declaring in both `entryPoints` arrays; the
  default is to keep the type beside the recommender.
- **Architecture:** one new edge, `cli-commands.ts` to `core/persona.js`
  (`mcp-server.ts` already has it). Confirm the layer model allows it before the
  build PR, or budget an allowance. The recommender never imports persona;
  resolution stays in the CLI layer.
- **Dead exports:** a new exported trace type must have a consumer in the same
  PR.

If F2 widens to MCP, add the MCP response-shape change and its contract tests;
if a new skill is added, the full new-surface checklist applies (perf identity,
both `entryPoints` arrays, arch allowance and floor bump).

### Documentation updates

- `canary recommend --help` and the CLI reference guide.
- `agents/canary-framework-advisor.md`: consume `trace` instead of inventing
  reasoning.
- #342 body: mark detection and persistence criteria as superseded by #462.

## Success criteria

1. For a fixed prompt, `canary recommend --reasoning --json` includes a
   `classify` trace entry naming the matched keyword and resulting `test_type`;
   a unit test asserts it for at least one prompt per category keyword list.
2. When the detected languages match no framework, the trace contains a
   `language-filter` fall-through entry; a unit test covers both the applied and
   fall-through cases.
3. A prompt-named framework, a `preferred` ranking and a license demotion each
   produce exactly one trace entry of their factor; three unit tests.
4. With `CANARY_PERSONA=sdet` and no flag, human output contains no
   `Why this pick:` section; with `CANARY_PERSONA=manual` or no persona env
   (fallback) it does; `--no-reasoning` suppresses it for every persona;
   `--reasoning` forces it for `sdet`. Four CLI tests.
5. Existing `--json` fields (`reasoning`, `alternatives`, `framework`) are
   byte-identical to `origin/main` for the existing snapshot prompts.
6. No trace entry text is produced by an LLM or template filler: every `detail`
   string is built from a value read during that call (asserted by planting a
   registry fixture with a unique framework name and checking it appears).
7. The trace section never appears inside generated test code: `canary run` and
   generation outputs are unchanged (existing snapshot tests stay green).
8. The build PR merges with zero new perf identities beyond one render helper,
   no `entryPoints` change, and no arch baseline refresh.

## Implementation order

1. Tests for the classifier rule trace, then implementation.
2. Tests for recommender ranking and fall-through trace, then implementation.
3. CLI flag, persona gating and rendering tests, then implementation.
4. Docs updates; update #342 body.

## Assumptions

- `resolvePersona` can be called from the CLI with detection based on the cwd
  and no open files, which today resolves to the `junior` fallback for most
  users (two independent signals are rarely available). So the default is "trace
  shown", which F3 accepts.
- The classifier's rule tables keep a stable matched-keyword identity.

## Accepted risks

- **A trace makes a wrong pick more convincing.** Mitigated by F6 and F7: the
  trace names fall-throughs and labels rule weights honestly, so a weak decision
  reads as weak.
- **Most users get the explanation by default.** Deliberate; `--no-reasoning`
  and `CANARY_PERSONA=sdet` are the off-switches and the persona line names
  them.
