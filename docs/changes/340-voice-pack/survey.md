# Survey: where report and voice output lives today (#340)

**Date:** 2026-09-16 · **Base:** `origin/main` at `e77f81b7` · **Status:**
survey answered, feeds `proposal.md`

## Question

Before designing the voice-pack wiring, what already exists, who reads it, and
where exactly does it touch #462 (persona system)?

## Method

Read the voice assets under `voice/`, grepped `ts/src`, `npm/src` and `agents/`
for `flavor`, `voice`, `reportBranding` and `persona`, and read the three
candidate emission surfaces named in #340: the test reporter, `canary doctor`,
and the CLI banner. Read #340 (body plus the 2026-07-28 triage and 2026-07-29
split comments) and #462 (body plus the correction comment; #462 is now closed
and shipped `ts/src/core/persona.ts`).

## Findings

### Voice assets (exist, mostly unread by code)

| Asset                                                          | What it is                                                                 | Read by                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `voice/discovery.md:22`                                        | Protocol: look for `.canary/voice.md` and two fallbacks, resolve a profile | Agent prose only: `agents/canary-test-author.md:62`, `agents/canary-test-generator.md:46`, `agents/canary-initializer.md` |
| `voice/discovery.md:7`                                         | Scope rule: voice applies to prose, never test code                        | Same three agents                                                                                                         |
| `voice/profiles/{batgirl,black-canary,huntress,clocktower}.md` | Four profiles (tone rules, vocabulary, openers, closers, anti-patterns)    | Agents via discovery, only when a consumer repo opts in; no TS code reads them                                            |
| `voice/quotes/birds-of-prey.md:14`                             | Verified-quote pool, **empty** by rule ("silence beats invention")         | `voice/profiles/clocktower.md:59` opener pattern                                                                          |
| `voice/quotes/house-aphorisms.md`                              | House aphorisms, labelled non-canon                                        | Same                                                                                                                      |

### Engine hooks (exist, zero production callers)

| Hook                                         | Location                                   | Callers                                                                       |
| -------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `reportBranding(flavor)` footer slot         | `ts/src/core/company-knowledge.ts:1119`    | **None outside tests** (`ts/test/company-knowledge.test.ts:811-1014`)         |
| One hard-coded voice line                    | `ts/src/core/company-knowledge.ts:874`     | Via `reportBranding` only                                                     |
| Off-switch `CANARY_NO_FLAVOR` / `NO_FLAVOR`  | `ts/src/core/company-knowledge.ts:875-886` | Via `reportBranding` only                                                     |
| CLI banner tagline "clocktower voice system" | `ts/src/ui/banner.ts:32`                   | `ts/src/cli-commands.ts` `version`; static string, not voiced, not switchable |

### Candidate emission surfaces

| Surface                  | Human output                                                                        | Machine output (must stay voice-free)                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `canary-test-reporter`   | Markdown, `agents/skills/claude-code/canary-test-reporter/scripts/render.mjs:56-57` | `--json-out` via `scripts/json_report.mjs`; exit code `scripts/cli.mjs:55-72,97`                        |
| `canary doctor`          | Human report, `npm/src/doctor.ts:284-335`                                           | `--json` contract `npm/src/doctor.ts:82-123`; exit 0/1/3 from `gateOutcome` `npm/src/doctor.ts:222-260` |
| `canary-screech` (siren) | Markdown blast                                                                      | `::error` annotation                                                                                    |

### Overlap with #462

Issue #462 shipped `ts/src/core/persona.ts`. Its header states the boundary in
code: `ts/src/core/persona.ts:26-31` — "Voice is not a persona field. Audience
depth and character voice are orthogonal axes." `AGENTS.md:301-303` restates it.
The only shared concept is _selection_: a persona resolves from explicit choice,
detected signal, or fallback (`persona.ts:13-21`), and the voice layer needs a
selection rule of its own. They share nothing else: no field, no registry, no
config file.

## Conclusion

1. The voice assets and the footer hook exist; **nothing in the product emits a
   voiced line today** — `reportBranding` has zero production callers and the
   profiles are read only by opt-in agent prose.
2. The value left in #340 is wiring into two or three human-output surfaces,
   each of which already has a separate machine channel (JSON file or `--json`,
   exit code, annotation) that voice must never enter.
3. #462 already drew the line: persona owns audience depth, voice is an
   orthogonal axis; #340 must not add a `voice` field to the persona registry.
