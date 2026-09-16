# Evidence survey: where reasoning and explanation depth live today (#342)

> **Status: Survey only.** Read against `origin/main` at `3e92492f`
> (2026-09-16). Line numbers are for that commit.

## Question

Issue #342 asks canary to annotate its choices with reasoning, with depth keyed
to the user's skill. Before designing anything: what already decides explanation
depth, what already emits a "why", and where is the "why" missing?

## 1. The audience model already exists (it shipped under #341 and #462)

| Surface          | Evidence                                                   | What it does                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detection        | `ts/src/core/environment-detect.ts` (`detectUserLevel`)    | Scores SDET vs manual from cwd and open files; returns level, signals, confidence (a margin, not a probability).                                                             |
| Persona registry | `ts/src/data/personas/registry.json:1-37`                  | Three personas. `sdet`: depth `terse`, `reasoning: false`. `junior`: `brief`, `reasoning: true`. `manual`: `guided`, `reasoning: true`. Fallback `junior`, 2-signal floor.   |
| Resolver         | `ts/src/core/persona.ts:353-431` (`resolvePersona`)        | explicit, then detected (gated by signal kinds and confidence), then fallback. Always returns `source` and a quotable `reason`.                                              |
| Design rationale | `ts/src/core/persona.ts:1-40`                              | States the #342 default in code: "the fallback is explanatory, not degraded"; over-explaining is a mild annoyance, under-explaining silently fails a manual tester.          |
| Wiring           | `ts/src/mcp-server.ts:467-522`                             | `analyze_file` attaches a `persona` block. Re-derives level without the analyzed file so the tool cannot count its own argument as evidence. `CANARY_PERSONA` is the escape. |
| Terminology      | `docs/knowledge/decisions/0016-two-meanings-of-persona.md` | "Persona" also means a test-data identity elsewhere; the audience meaning must be named explicitly.                                                                          |

The issue's `auto` default ("on for manual/unknown, off for SDET") is therefore
**already encoded as data**: the `reasoning` boolean on each persona plus the
explanatory fallback. The issue's persistence criterion is also answered by the
design: nothing is stored; the persona is recomputed per call.

## 2. Consumers of that model: exactly one

| Consumer                                                                    | Evidence                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `agents/skills/claude-code/canary-edge-case-discovery/SKILL.md:81-127, 151` | Reads the persona block or `--level`; renders by `depth`; when `reasoning` is true, quotes `persona.reason`. |

No other skill, agent or CLI command reads `persona`, `depth` or `reasoning`
(grep across `agents/`, `ts/src/`). Every other skill is audience-blind.

## 3. Where a "why" is already emitted, and how thin it is

| Surface                            | Evidence                                                          | What the "why" actually is                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canary recommend` human output    | `ts/src/cli-commands.ts:139-140`                                  | Always prints a `Reasoning:` list, regardless of persona.                                                                                                                                                            |
| `canary recommend --json`          | `ts/src/cli-commands.ts:123`                                      | `reasoning: result.reason`.                                                                                                                                                                                          |
| Source of that list                | `ts/src/core/recommender.ts:55-61`                                | `buildReason` copies registry prose: `recommended_for`, first two `strengths`, maturity. It describes the framework, **not the decision**.                                                                           |
| Ranking actually applied           | `ts/src/core/recommender.ts:100, 109-132`                         | Language filter (with silent fall-through to the unfiltered pool when nothing matches), prompt-named hint first, `status: preferred` before the rest. None of this reaches `reason`, except the hint line at `:147`. |
| License demotion note              | `ts/src/core/recommender.ts:71-76`                                | Prepended warning. A real decision factor, already surfaced.                                                                                                                                                         |
| Classification ("why API not E2E") | `ts/src/core/classifier.ts:171-210`                               | Returns `test_type` and a fixed confidence (for example `0.85` for the api rule at `:186`). The keyword that matched is discarded, so "why API over E2E" is unanswerable today.                                      |
| Framework advisor agent            | `agents/canary-framework-advisor.md:84`                           | LLM prose "reasoning", no structured input from the engine.                                                                                                                                                          |
| Registry authoring guidance        | `agents/skills/claude-code/canary-add-framework/SKILL.md:88, 167` | Tells authors that sparse metadata makes the reasoning string sparse: confirms the reasoning is metadata, not trace.                                                                                                 |

## 4. Items in #342 with no canary surface at all

- **"Why a specific test user was selected."** Canary does not select test
  users. Credential and user lookup is delegated to a consumer-declared
  `user_catalog_skill`
  (`agents/skills/claude-code/canary-ci-ready/SKILL.md:162-163`). There is no
  decision in canary to annotate.
- **"Why a particular coverage skill was chosen."** Skill dispatch exists
  (`ts/src/core/skill-dispatch.ts`) and is named in #342, but it is a different
  decision engine from the recommender; deferred and unexamined here.

## Conclusion

1. The skill-level signal, the `auto` default and the privacy answer all ship
   already (personas, #462); #342 must consume that model, not build a second.
2. The real gap is the content of the "why": `recommend` prints registry prose,
   and the classifier and ranking discard the facts that made the decision.
3. The smallest honest slice is a decision trace from classifier plus
   recommender, rendered by `canary recommend`; test-user reasoning is out of
   scope because canary makes no such decision.
