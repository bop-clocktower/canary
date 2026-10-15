---
number: 0041
title: No model sits in gen-data's value path
date: 2026-10-15
status: proposed
tier: small
source: docs/changes/765-synthetic-test-data/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0041 — No model sits in gen-data's value path

**Status:** proposed **Date:** 2026-10-15 **Deciders:** Bri Stevenski
(maintainer) **Related:**
[#765](https://github.com/bop-clocktower/canary/issues/765);
`docs/changes/765-synthetic-test-data/proposal.md` (D7, with D4 and D8); ADR
0009 (exit 3 reserved for "abstained"); ADR 0001 (host-LLM generation for
agents); ADR 0005 (LLM abstraction layer removed); ADR 0040 (#765 D2, the shape
source)

## Context

`canary gen-data` turns a shape into a seeded, literal-only vitest fixture
module. #765 started from a throwaway prompt-box prototype: one free-text
prompt, no shape awareness, no seed, no framework output. The proposal rejected
it as a capability (proposal, Overview; approach B in "Approaches considered":
"Non-deterministic, shapes hallucinated, no honest denominator").

Three of the proposal's signed-off decisions (human sign-off 2026-09-15, D1-D8
accepted as written) depend on nothing non-deterministic sitting between the
shape and the emitted values:

- **D4.** Values are generated at emit time from a seed and written into the
  file as literals, so the test never touches a PRNG or a clock.
- **D8.** On partial resolution the command exits 0 with a disclosed denominator
  (`fieldsResolved/fieldsTotal`) and a placeholder that fails; zero resolved
  exits 3. An unresolved field is never filled with a guessed value.
- **ADR 0009.** Exit 3 means "abstained", never "passed". A model that filled
  the gaps would turn an abstention into a fabricated success, which is the
  defect class ADR 0009 exists to stop.

D7 asked where a model may be used inside the command. The proposal says D7
warrants an ADR alongside ADR 0009's abstention doctrine ("Architectural
decisions"). This record writes down the signed-off answer. It does not
re-decide it.

What the shipped code does today (verified at `origin/main` `be26f0a9`):

- `ts/src/gen-data/gen-data-cli.ts:20-35` imports only `node:fs`, `node:path`,
  `commander`, canary's CLI helpers, the `ts/src/core/gen-data/` modules,
  `EXIT_ABSTAINED` and the `MainDeps` type. The command uses three `MainDeps`
  members: `out`, `cwd` and `genDataSelfCheck`. It uses no subprocess runner, no
  network and no agent backend.
- `ts/src/core/gen-data/*.ts` import only each other, `node:fs`, `node:path`,
  `node:url` and `../skill-registry.js`. The PRNG is a local `mulberry32` with a
  fixed `DEFAULT_SEED = 765` (`prng.ts:5-17`).
- The one dynamic `import()` (`self-check.ts:41`) loads the bundled
  `canary-blackhawk` and `canary-savant` `scanner.mjs` files from the skills
  directory. It does not load a model client.
- An unresolved top-level field becomes a guard that throws
  `gen-data: <name>.<key> is unresolved (<reason>); pass it via overrides`
  (`emit-vitest.ts:124-133`). An unresolved or all-unresolved root abstains with
  `EXIT_ABSTAINED` (`gen-data-cli.ts:100-149`).
- `ts/package.json` runtime dependencies contain no model SDK.

So no model or LLM call can be reached from the command today.

## Decision

**`canary gen-data` calls no model in v1** (D7 option (a)). This covers four
things:

1. **Shape.** A model never decides a field's type or fills an `unresolved`
   node. Shapes come from the deterministic sources ADR 0040 records.
2. **Values.** A model never chooses a value. Every value comes from the seeded
   generator and the category strategies (`generate.ts`, `strategies.ts`).
3. **Seed.** A model never chooses the seed. The default is a constant and
   `--seed` is validated as savant's is (`parseSeed`, bad value exits 2).
4. **Gaps.** An unresolved field stays unresolved. It is disclosed in the report
   and emitted as a failing placeholder (D8). Zero resolved exits 3 (ADR 0009).

A model may still act **around** the command: the calling agent (for example
`canary-test-author`) runs in the host session and may read the emitted fixtures
and the `unresolved` list to ask the human a question. That is the ADR 0001
pattern, where the host LLM does the generative work and the engine does none.

**How this relates to ADR 0001 and ADR 0005.** ADR 0001 moved generation into
the host LLM session, and ADR 0005 deleted the engine's provider layer. Neither
says whether a new engine command may bring a model back for its own values.
This ADR answers that for `gen-data`: the engine still holds no model client,
and on top of that it rules out a model in this command's value path through any
route, including a subprocess to a host CLI. It narrows those ADRs and
supersedes neither.

**Later work.** Opt-in LLM string placeholders for already-resolved `string`
fields (proposal, "Where a model may and may not be used", later-phase bullet)
are not part of v1. If built, they need their own spec and a new ADR that amends
this one. The proposal's constraints come with it: values labelled
`source: "llm"` in the report and excluded from the determinism guarantee unless
written to the fixture as literals.

## Consequences

- Determinism holds by construction. The same shape and seed give a
  byte-identical file (`ts/test/gen-data-cli.test.ts:251`), and no non-seeded
  input exists to break that.
- The denominator stays honest. `fieldsResolved/fieldsTotal` counts what the
  shape sources resolved, not what a model guessed.
- The command runs offline, keyless and at zero cost. That matches ADR 0001's
  no-API-key promise and ADR 0005's provider-free engine.
- Fixtures for odd or loosely typed shapes are less complete than a model could
  make them. The user fills those fields through `overrides`, and the throwing
  guard says which ones.
- **Finding: nothing mechanical enforces this yet.** A later PR that added a
  model call to `ts/src/gen-data/` or `ts/src/core/gen-data/` would be caught
  only by human review:
  - `harness.config.json` `forbiddenImports` has rules for `ts/src/util/**` and
    `ts/src/core/**` only, and neither forbids model SDKs or subprocess runners.
  - No test asserts gen-data's import surface.
  - `MainDeps` already exposes a `spawnSync`-backed runner
    (`ts/src/main-deps.ts:135`) that the command could pick up without a new
    import.
  - The byte-identical test would fail on a live non-deterministic call, but not
    on a mocked or cached one.

  The cheapest mechanical guard would be a `forbiddenImports` rule, or an
  import-surface test, for the two gen-data trees. This is a follow-up and
  outside this ADR's scope.

### Assumptions made

- The decision is recorded exactly as signed off on 2026-09-15. The architecture
  advisor's discovery and choice gates were settled by that sign-off, so no new
  options were weighed.
- "Value path" covers shape, values, seed and unresolved-gap handling, following
  the proposal's "Never" list. It does not cover a calling agent's use of the
  output.
- A model reached through a subprocess (for example a host CLI) counts as a
  model in the command, the same as an in-process SDK.
- The enforcement gap is recorded as a Consequence and not filed as an issue
  from this lane. The orchestrator files issues.

## Alternatives Considered

- **(b) Opt-in LLM string placeholders in v1.** Adds variety to already-resolved
  `string` fields. Rejected for v1: it brings in a provider or host-CLI
  dependency and a second, unseeded value source before the deterministic path
  has shipped. It is deferred to a later, separate spec with its own ADR.
- **(c) A model fills unresolved shapes.** This is the prototype #765 rejected.
  It replaces an honest abstention with a guessed shape that looks like a
  resolved one, so the denominator lies and exit 3 can no longer fire when it
  should. That breaks no-silent-abstention (ADR 0009) and D8. Rejected.
