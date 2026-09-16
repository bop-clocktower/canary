# Voice pack: wire BoP character voices into human-facing output (#340)

**Keywords:** voice, flavor, garnish, report-footer, off-switch, test-reporter,
doctor, birds-of-prey, machine-output-invariant

> **Status: Spec only — not signed off.** No human has reviewed this proposal.
> Every fork below (F1-F8) carries a recommended default chosen by the authoring
> lane without asking; each is an open question until a human accepts or
> overrides it. The document contains no code, no skill files and no CLI wiring.
> The evidence is in [`survey.md`](survey.md).

## Overview

Canary has four voice profiles, a quote pool, a report-footer hook and an
off-switch. None of it reaches a user: `reportBranding` has zero production
callers and the profiles are read only by opt-in agent prose (survey.md, first
conclusion). This change wires voice into a small number of human-facing output
surfaces, adds the missing cast, and keeps voice strictly garnish.

### Goals

1. At least one shipped human-output surface emits a voiced line by default,
   drawn from a profile, with the plain fact always present beside it.
2. One off-switch (`CANARY_NO_FLAVOR`, plus a `--no-flavor` flag where a CLI
   surface exists) removes every voiced line.
3. Voice never changes machine-readable output (invariant below).
4. Remaining cast profiles exist with the same structure as the existing four.

### Out of scope

- Anything the persona system owns (audience depth, explanation level, format
  choice). See the boundary below.
- HTML brand-styling injection for overlays (F7).
- Generated or "canon-shaped" quotes; the verified pool stays empty until a
  sourced contribution lands (`voice/quotes/birds-of-prey.md`).
- Voicing test code, fixtures or generated tests (already excluded by
  `voice/discovery.md:7`).

## Invariant: voice never touches machine-readable output

**Voice is presentation only. It shall never appear in, alter, or depend on the
presence of any machine-readable channel.** Concretely:

- JSON outputs (`--json`, `--json-out`, `run.json`, MCP tool results) are
  byte-identical with flavor on and off.
- Exit codes are identical with flavor on and off.
- `::error` / `::warning` / `::notice` annotation lines carry no voiced text.
- Voice lines are never the only carrier of a fact: removing every voiced line
  leaves a report that states the same results.
- If voice resolution fails (missing profile, unreadable file), output falls
  back to the unvoiced form silently and the exit code is unaffected.

## Boundary with #462 (persona system)

**#462 decides _how much to explain and to whom_; #340 decides _what character
the garnish line speaks in_; they never share a field, registry or config
file.** #462 shipped `ts/src/core/persona.ts`, which already declares "voice is
not a persona field" (`persona.ts:26-31`, `AGENTS.md:301-303`). This spec adds
nothing to `ts/src/data/personas/registry.json` and does not read the resolved
persona.

## Forks for the human

Each fork records where the brainstorming method would have asked. The default
applies until overridden.

| #   | Question                                 | Options                                                                                                                             | Recommended default                                     | Reason                                                                                                                                              |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | First surface to wire                    | (a) test-reporter Markdown footer; (b) `canary doctor` pass/fail line; (c) session responses via skills; (d) all at once            | **(a) test-reporter Markdown footer**                   | Self-contained `.mjs` skill, Markdown and JSON already separate files (`render.mjs:56`, `json_report.mjs`), so the invariant is cheap to test.      |
| F2  | Default on or off                        | (a) on, `CANARY_NO_FLAVOR` turns off; (b) off, opt-in                                                                               | **(a) on**                                              | Matches shipped `resolveFlavor` (`company-knowledge.ts:882-886`) and #340's "actually use them". Invariant makes on-by-default safe for CI parsers. |
| F3  | Where lines come from                    | (a) hard-coded strings in TS; (b) a `lines:` block parsed from each `voice/profiles/*.md` frontmatter; (c) a new `voice/lines.json` | **(c) `voice/lines.json`, keyed by profile and moment** | Profiles are prose for LLMs; parsing Markdown for a CLI is fragile. One JSON file is testable and shippable in both npm and skill bundles.          |
| F4  | Which voice speaks on a surface          | (a) fixed per surface (reporter = Black Canary); (b) project `.canary/voice.md` selects; (c) random per run                         | **(a) fixed per surface, (b) as override**              | Deterministic output keeps snapshot tests stable; (c) breaks byte-identical reruns. Reuses the existing discovery file rather than a new config.    |
| F5  | Voice line selection within a profile    | (a) first line only; (b) seeded by a stable input (e.g. run totals)                                                                 | **(b) seeded by the report's own counts**               | Variety without nondeterminism: same results give the same line.                                                                                    |
| F6  | Remaining cast                           | (a) all five now (Cassandra, Savant, Misfit, Montoya, Zinda); (b) only voices with a surface or skill mapping; (c) defer            | **(b) only mapped voices**, land each with its skill    | #340's split comment: voice mapping should ship with the skill it serves. Profiles nothing reads are the failure this issue exists to fix.          |
| F7  | Overlay HTML brand-styling hook          | (a) in this spec; (b) separate follow-up issue                                                                                      | **(b) follow-up**                                       | No HTML report producer exists in the engine today; designing an injection slot with no consumer is speculative (YAGNI).                            |
| F8  | Banner tagline "clocktower voice system" | (a) leave; (b) make it honour the off-switch; (c) rename                                                                            | **(a) leave**                                           | Static brand text on `version`, not a voiced line; `clocktower` is a reserved skill name per #340, so a rename is its own naming call.              |

### Approaches considered

1. **Wire the existing `reportBranding` hook into surfaces (recommended).**
   Extend its single hard-coded line into a lookup against `voice/lines.json`
   for TS surfaces (doctor); the self-contained reporter skill reads the same
   file directly, since it cannot import engine code. Low complexity; reuses the
   shipped off-switch. Risk: the hook lives in `company-knowledge.ts`, which is
   the wrong home long-term; moving it is a later refactor.
2. **A new `ts/src/core/voice.ts` module that every surface calls.** Cleaner
   ownership, but a new module trips the entropy and arch ratchets and doubles
   the flavor resolution unless `reportBranding` is rewritten to call it. Medium
   complexity.
3. **LLM-only: skills read profiles and voice their own prose.** Zero engine
   cost, but non-deterministic, untestable against the invariant, and already
   the status quo that emits nothing.

## Technical design

- `voice/lines.json`: `{ "<profile>": { "<moment>": ["line", ...] } }`, moments
  `report.pass`, `report.fail`, `report.flaky` for slice 1.
- The test reporter appends one footer paragraph to the Markdown only:
  attribution plus one voiced line, both suppressed under the off-switch.
  `json_report.mjs` and the exit path in `cli.mjs` are not touched.
- Selection is a pure function `(profile, moment, counts) -> line | ''`.

## Integration points

### Entry points

- `canary-test-reporter` Markdown output (slice 1).
- Later slices: `canary doctor` human report, skill session responses.

### Registrations required

- Ship `voice/lines.json` in the skill bundle and npm package file lists.

### Ratchet cost (known, budget before the build PR)

- Slice 1 under Approach 1 adds **no new TS module**: the reporter is a
  self-contained `.mjs` skill, so no `entropy.entryPoints` or
  `performance.entryPoints` change is expected. If the selector is a new
  `scripts/*.mjs` file it must be declared in both `entryPoints` arrays in
  `harness.config.json` (entropy analyzer cannot follow `./x.js`).
- Approach 2 adds a `ts/src/core/voice.ts` module: one arch-layer allowance,
  both `entryPoints` arrays, and any new export counted by the dead-export and
  perf-complexity ratchets. A new CLI flag (`--no-flavor`) on `canary` is a new
  CLI surface under the perf delta rule and needs paydown in the same PR.

### Documentation updates

- `voice/discovery.md`: note that engine surfaces also read `voice/lines.json`.
- Test-reporter `SKILL.md`: footer and off-switch.
- `AGENTS.md`: the machine-output invariant, next to the persona boundary.

### Architectural decisions

- The machine-output invariant is ADR-worthy: it binds every future surface.

## Success criteria

1. With flavor on, `canary-test-reporter` Markdown for a fixture run ends with
   exactly one attribution line and one non-empty voiced line.
2. With `CANARY_NO_FLAVOR=1`, the same Markdown contains no line from
   `voice/lines.json` and no attribution voice line.
3. For every fixture, the `--json-out` file is byte-identical with flavor on and
   off (test asserts SHA equality).
4. For every fixture, the process exit code is identical with flavor on and off,
   including an all-fail fixture.
5. No `::error`/`::warning` line emitted by any wired surface contains a string
   from `voice/lines.json` (test scans captured stdout).
6. Two runs over the same fixture produce the same voiced line.
7. Deleting `voice/lines.json` yields unvoiced Markdown and an unchanged exit
   code.
8. Every profile keyed in `voice/lines.json` has a matching
   `voice/profiles/<name>.md`, and vice versa for mapped profiles (test).

## Implementation order

1. **Smallest shippable slice:** `voice/lines.json` with Black Canary `report.*`
   lines, test-reporter Markdown footer, off-switch, and the invariant tests
   (criteria 1-7).
2. `canary doctor` pass/fail line, reusing the same selector.
3. Remaining cast, each landing with its skill mapping (F6).
4. Follow-up issue for overlay HTML styling (F7).

## Assumptions

- The test reporter's Markdown and JSON remain separate outputs.
- `CANARY_NO_FLAVOR` stays the single documented off-switch.

## Accepted risks

- Voiced lines may read as noise to some users; the off-switch is the
  mitigation, and the invariant keeps it cosmetic.
