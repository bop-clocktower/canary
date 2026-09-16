# Synthetic test data: seeded, shape-derived fixtures (#765)

**Keywords:** test-data, fixtures, factories, seeded-generation,
shape-extraction, edge-case-coupling, abstention, determinism

> **Status: signed off 2026-09-15.** A human reviewed this proposal and accepted
> its decisions D1-D8 as written, so the recommended defaults stand and a build
> round may proceed from it (sign-off recorded on #765). The document itself is
> still spec only: it contains no code, no scripts and no workflow changes, and
> the defaults marked _assumption_ were chosen by the authoring lane rather than
> asked. Implementation starts with the D2 spike on TypeScript compiler API
> cost.

## Overview

Canary generates tests but not the data those tests run on. Every adjacent
capability assumes the inputs already exist:

- `canary-write-test` and the `canary-test-author` agent produce the _test_, not
  its inputs.
- `canary-edge-case-discovery` names cases in six categories
  (`agents/skills/claude-code/canary-edge-case-discovery/SKILL.md:41-78`) but
  emits prose only (its output format is a text block, lines 129-147), so
  someone still has to construct `amount = MAX_SAFE_INTEGER` by hand.
- Hand-picked numeric inputs are a known hazard: `SOUND-003` in
  `ts/src/core/static-linter.ts:632-647` exists because a ratio pinned to an
  integer leaves the realworld S4 integer/fractional contract unpinned.

A throwaway prompt-box prototype (deleted, see #765) showed the idea, but a
single free-text prompt with no shape awareness, no seed, and no framework
output is not a capability. This spec describes one.

### What exists today (verified)

| Claim in #765                                  | Reality in the code                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "derive the shape the way `analyze_file` does" | `analyzeFileImpl` (`ts/src/mcp-server.ts:439-523`) returns framework, imports, project functions, `file_functions`, existing tests, 40 context lines, environment and persona. `extractFileFunctions` (`:387`) is a regex over names only. **No parameter types or field shapes are extracted anywhere.** |
| Fixture awareness                              | `FixtureScanner` (`ts/src/core/fixture-scanner.ts`) finds exported symbol _names_ under conventional fixture dirs, regex-based, no AST. Useful to avoid duplicating an existing factory; not a shape source.                                                                                              |
| AST tooling                                    | `typescript` is a **devDependency** only (`ts/package.json:33`). No module imports the compiler API. `zod` **is** a runtime dependency (`ts/package.json:26`).                                                                                                                                            |
| Edge-case output                               | Prose. No machine-readable form exists to consume.                                                                                                                                                                                                                                                        |
| Determinism detectors                          | `canary-blackhawk` flags `Date.now()`/bare `new Date()`/`datetime.now()` (BH001) and real delays (BH002). `canary-savant` flags module-level mutables tests mutate (SV001). Neither flags `Math.random`.                                                                                                  |

So the honest starting point is: the shape-derivation half of this feature does
not exist yet and is the largest piece of work.

### Goals

1. Given a target function or type and a seed, produce the same fixture values
   byte-for-byte on every run.
2. Derive value shapes from the code (TS types, Python annotations) or an
   explicit schema, never from a model's guess.
3. Cover the edge-case categories that are data-expressible, and say which ones
   were not covered and why.
4. Emit framework-native code (vitest factory, pytest fixture) that passes
   `canary-blackhawk` and `canary-savant` with zero findings.
5. Abstain loudly (exit 3, ADR 0009) when no shape can be derived.

### Out of scope

- Database seeding, migrations, or fixtures against live services.
- Realistic-looking PII-like data (names, emails) beyond clearly synthetic
  placeholders.
- Property-based testing frameworks (fast-check, Hypothesis) as a replacement;
  see D6.
- Race-condition, partial-network and accessibility categories: they are about
  _timing and environment_, not values, and cannot be expressed as fixture data.

## Decisions made

These were taken as the brainstorming skill's recommended defaults in autonomous
mode. The ones a human must confirm are repeated under **Decisions for the
human**.

1. **It belongs in canary, not harness.** Test data is test intelligence
   (`STRATEGY.md#tracks`, "Test intelligence depth"), consumed by canary's own
   generators, and gated by canary's own detectors. harness has no
   test-authoring surface to attach it to.
2. **Engine module plus `canary` CLI subcommand first; skill wrapper later.**
   Canary splits deterministic, self-contained linters into skills with
   `cli: scripts/cli.mjs` (11 skills, e.g. `canary-blackhawk/SKILL.md:8`) and
   engine features that reuse `ts/src/core` into `canary <cmd>` subcommands
   (`review-test`, `vacuity-check`, `heal-test` in `ts/src/cli.ts`). Generation
   needs the core scanners, so it is an engine feature.
3. **Shapes come from a deterministic extractor, never from an LLM.**
4. **Seeded PRNG at emit time; the emitted test holds literals only.**
5. **v1 emits vitest and pytest only.**

### Approaches considered

| Approach                                                      | How it works                                                                                                                                                    | Gain                                                                 | Lose                                                                                       | Complexity  | Risk                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------- |
| **A. Deterministic extractor + seeded emitter** (recommended) | TS compiler API / Python `ast` extracts a `ShapeNode` tree; a pure generator walks it with a seeded PRNG and category strategies; emitters print framework code | Reproducible, testable, no model in the value path, clean abstention | Needs `typescript` at runtime; unsupported types abstain rather than guess                 | Medium-High | Compiler API cost and TS version coupling                 |
| B. LLM generation constrained by `analyze_file` context       | Feed context snippets to a model and ask for fixtures                                                                                                           | Fast to build; handles odd types                                     | Non-deterministic, shapes hallucinated, no honest denominator; the prototype #765 rejected | Low         | Fixtures become flake sources and silent wrong-shape data |
| C. Schema-only input (zod / JSON Schema)                      | User passes an explicit schema; no code analysis                                                                                                                | Smallest and fully deterministic; `zod` already a runtime dep        | Does not meet "derive from the type under test"; users without schemas get nothing         | Low         | Low adoption                                              |

**Recommendation:** A, with C's schema input as a second shape source inside the
same pipeline (it is cheap once `ShapeNode` exists). B is rejected for the value
path; a model is allowed only where D7 says.

## Technical design

### Pipeline

```text
target (file#symbol | schema file)
   │
   ▼
shape extractor ── cannot resolve ──► abstain (exit 3, reasons[])
   │ ShapeNode tree + unresolved[]
   ▼
case planner  ◄── edge-case plan (optional, JSON)
   │ CasePlan: [{category, path, strategy}]
   ▼
seeded generator (pure, seed → values)
   │ FixtureSet + coverage denominator
   ▼
emitter (vitest | pytest)  ──► file under tests/generated/fixtures/
   │
   ▼
self-check: run blackhawk + savant scanners on emitted file (must be 0)
```

### Shape model

```ts
// Synthetic illustration, not an existing API.
type ShapeNode =
  | { kind: 'string'; minLength?: number; maxLength?: number; enum?: string[] }
  | { kind: 'number'; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'array'; item: ShapeNode }
  | {
      kind: 'object';
      fields: Record<string, { node: ShapeNode; optional: boolean }>;
    }
  | { kind: 'union'; members: ShapeNode[] }
  | { kind: 'unresolved'; reason: string; typeText: string };
```

Example target: `function priceOrder(order: Order): Money` where
`interface Order { id: string; lines: OrderLine[]; coupon?: string }`.

### Shape sources (v1)

| Source                     | Mechanism                                                                                    | Status today                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TS function params / types | TypeScript compiler API, resolving imported types within the project                         | **Opt-in second source** (D2 revisited): guarded dynamic import, version-gated to TS 5.x-6.x, abstains by name on 7.x or absence |
| Python signatures          | `python3 -c` with stdlib `ast` over annotations (dataclass, TypedDict, pydantic field names) | **New.** No Python analysis exists in `ts/src` since the TS port                                                                 |
| Explicit schema            | JSON Schema or zod schema module; `zod` is already a runtime dependency                      | **PRIMARY source in v1** (D2 revisited), small                                                                                   |
| Symbol targeting           | Reuse `extractFileFunctions` names to validate `file#symbol` exists before the AST pass      | Exists (`ts/src/mcp-server.ts:387`)                                                                                              |
| Existing factories         | Reuse `FixtureScanner` to warn when a factory named `buildOrder` already exists              | Exists (`ts/src/core/fixture-scanner.ts:59`)                                                                                     |

Anything the extractor cannot resolve (`any`, `unknown`, generics without a
concrete argument, conditional/mapped types, untyped Python params) becomes an
`unresolved` node. It is never filled with a guessed shape.

### Edge-case coupling

`canary-edge-case-discovery` gets an additive `--format json` output (the text
output is unchanged) shaped as
`{ target, cases: [{ category, field?, description }] }`. The case planner maps
categories to value strategies:

| Category                                      | v1 strategy                                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Boundary values                            | numbers: `0, -1, 1, MIN/MAX_SAFE_INTEGER, min-1, max+1`, and one fractional value for every `integer:false` field (the SOUND-003 case); strings: empty, whitespace, `maxLength+1`; arrays: empty, one |
| 3. Locale and timezone                        | fixed ISO-8601 UTC literals including a DST-transition instant and `2024-02-29T23:59:59Z`; non-ASCII, RTL, emoji strings                                                                              |
| 5. Unexpected input shapes                    | missing required field, extra field, wrong primitive type, `null` for non-nullable, one level of over-nesting                                                                                         |
| 2. Race, 4. Partial network, 6. Accessibility | **Not data-expressible.** Reported as `notCovered` with that reason, never silently dropped                                                                                                           |

Without an edge-case plan, the planner runs every data-expressible strategy over
every resolved field.

### Determinism

- Generation is a pure function of `(ShapeNode, CasePlan, seed)`. The default
  seed is a fixed constant, not time-based; `--seed <int>` overrides it and is
  validated as savant's `--seed` is (bad value → exit 2).
- Emitted code contains **literal values**, not a runtime generator call, so the
  test never touches a PRNG or a clock. Dates are ISO string literals parsed
  with an explicit `Z`, so BH001/BH003/BH004 cannot fire.
- Factories return a fresh object per call (`buildOrder(overrides)`), never a
  shared module-level mutable, so SV001 cannot fire. pytest fixtures are
  function-scoped by default (no SV002).
- The emitter runs the blackhawk and savant scanners over its own output before
  writing; a non-zero finding count fails the command (a generator bug, not a
  user error).

### Emission (v1)

| Framework  | v1? | Output                                                                                                              |
| ---------- | --- | ------------------------------------------------------------------------------------------------------------------- |
| vitest     | yes | `orderFixtures.ts` exporting `buildOrder(overrides?)` and `orderCases: { name, value, category }[]` for `it.each`   |
| pytest     | yes | `conftest`-compatible module with `@pytest.fixture` builders and a `ORDER_CASES` list for `pytest.mark.parametrize` |
| Playwright | no  | `test.use` / fixtures-extension — later phase; form data is mostly strings and needs page context                   |
| k6         | no  | `SharedArray` JSON data file — later phase                                                                          |

Output goes under `tests/generated/fixtures/`, matching `canary-generate-test`'s
`tests/generated/` convention and `canary-promote-test`'s promotion path.

### Reported result

```json
{
  "target": "src/pricing.ts#priceOrder",
  "seed": 765,
  "fieldsTotal": 7,
  "fieldsResolved": 6,
  "unresolved": [{ "path": "order.meta", "reason": "type is unknown" }],
  "casesEmitted": 23,
  "categoriesCovered": ["boundary", "locale-timezone", "unexpected-shape"],
  "notCovered": [{ "category": "race", "reason": "not data-expressible" }],
  "output": "tests/generated/fixtures/priceOrder.fixtures.ts"
}
```

### Exit codes

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 0    | Fixtures emitted; `fieldsResolved > 0`                                                                 |
| 1    | Emitted file failed its own blackhawk/savant self-check                                                |
| 2    | Usage error (bad seed, unknown framework, target not found)                                            |
| 3    | Abstained: `fieldsResolved == 0`, or target symbol found but no shape source could parse it (ADR 0009) |

### Where a model may and may not be used (D7)

- **Never:** deciding a field's type, choosing values, choosing the seed, or
  filling an `unresolved` node.
- **Allowed, v1:** none inside the command. The calling agent
  (`canary-test-author`) may use the emitted fixtures and the `unresolved` list
  to ask the human a question.
- **Allowed, later phase, opt-in:** suggesting domain-plausible _string
  placeholders_ for already-resolved `string` fields, labelled `source: "llm"`
  in the report and excluded from the determinism guarantee unless the
  suggestions are written to the fixture as literals.

## Integration points

### Entry points

- New CLI subcommand (placement is D1), for example:

  ```text
  canary gen-data <file#symbol | --schema path>
    --framework vitest|pytest [--seed n] [--cases edge-cases.json] [--json]
  ```

- New engine modules under `ts/src/core/` (shape extractor, case planner, seeded
  generator, emitters).
- Additive `--format json` for `canary-edge-case-discovery`.
- Later: MCP tool `canary__generate_fixtures` and skill guidance in
  `canary-test-author` to call it.

### Registrations required

- Commander registration in `ts/src/cli.ts`.
- The new-CLI-surface ratchets: `entropy.entryPoints` (both arrays), dead
  exports, perf complexity, architecture layer allowance — declared, never by
  raising a ceiling.
- `typescript` dependency change in `ts/package.json` (D2).

### Documentation updates

- AGENTS.md command list and core-module map.
- `canary-edge-case-discovery/SKILL.md` for the JSON output.
- `canary-write-test` / `canary-test-author` guidance to prefer generated
  fixtures over inline literals.

### Architectural decisions

- D2 (compiler API as a runtime dependency) warrants an ADR: it changes the
  install footprint of the published package.
- D7 (no model in the value path) warrants an ADR, alongside ADR 0009's
  abstention doctrine.

### Knowledge impact

A knowledge entry on "data-expressible vs environment-expressible edge-case
categories", and the `ShapeNode` concept as the canary term for extracted
shapes.

## Success criteria

EARS-style; each is checkable by a later build lane and `outcome-eval`.

1. **Determinism.** When `canary gen-data` runs twice on the same target with
   the same seed, the system shall write byte-identical output files.
2. **Seed sensitivity.** When the seed changes, the system shall change at least
   one emitted string or non-boundary numeric value (boundary values are fixed
   by definition).
3. **Shape fidelity.** When the target is a synthetic `interface Order` with
   fields `id: string`, `total: number`, `lines: OrderLine[]` and
   `coupon?: string`, the emitted default factory value shall type-check against
   `Order` under `tsc --noEmit`.
4. **Abstention (denominator).** If `fieldsResolved` is 0, then the system shall
   exit 3, write no fixture file, and print every unresolved path with its
   reason. It shall not exit 0.
5. **Partial disclosure.** When some but not all fields resolve, the system
   shall exit 0 and report `fieldsResolved/fieldsTotal` in both human and
   `--json` output, listing every unresolved path.
6. **No guessed shapes.** If a field's type is `any`, `unknown`, or an untyped
   Python parameter, then the system shall not emit a value for that field other
   than an explicit `overrides`-required placeholder that fails type-checking or
   raises, making the gap visible.
7. **Detector clean.** When fixtures are emitted for vitest or pytest, running
   `canary-blackhawk` and `canary-savant` over the output shall report 0
   findings; a fixture corpus of at least 5 synthetic targets proves it.
8. **Category accounting.** When an edge-case plan is supplied, every case in
   the plan shall appear in exactly one of `categoriesCovered` or `notCovered`
   (sum of both equals plan size).
9. **SOUND-003 closure.** When a resolved field is a non-integer `number`, the
   emitted cases shall include at least one fractional value.
10. **Framework-native.** The vitest output shall run under `it.each` and the
    pytest output under `pytest.mark.parametrize` in the
    `examples/vitest-unit-validation` and `examples/pytest-api-checkout` style
    projects without edits.
11. **No company-specific content.** The emitted placeholders and fixtures
    corpus shall pass the repo's leak gate (no real names, emails or domains).

## D2 revisited after the spike (2026-09-15)

The D2 spike ran (`spike/765-shape-extraction/SPIKE_REPORT.md`, PR #986) and its
result **changes the ordering in this spec**. A human accepted the spike's
recommendation on 2026-09-15; the shape model, seeded generator, emitters,
abstention doctrine and exit-code contract below are unchanged.

What the spike measured:

| Question                                | Result                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold cost, one file plus imports        | 306 ms / 183 MB median (5 runs, TS 5.9.3). ~145 ms of that is `import('typescript')` alone, scope-independent                                                                                                                          |
| Cold cost, whole `ts/src`               | 553 ms / 273 MB                                                                                                                                                                                                                        |
| Against the A1 budget (5 s)             | Met with 16x headroom — but 4.0x-7.2x the entire current CLI invocation (77-85 ms median)                                                                                                                                              |
| Extraction feasibility                  | 0 of 4 real `ts/src/core` targets abstain with a full program; leaf-level abstention 10/70, only 1/70 a genuine compiler limit                                                                                                         |
| Parse-only alternative                  | 153 ms, but resolves no imported interface — 3 of 4 targets abstain. Not a viable primary path                                                                                                                                         |
| `noResolve`                             | Disqualified: silently rewrites unresolvable imports to `any`, indistinguishable from an author-written `any`                                                                                                                          |
| Version coupling, 5.4.5 / 5.9.3 / 6.0.3 | Retired. All 43 probed entry points present, extracted shapes byte-identical                                                                                                                                                           |
| **`typescript@7.0.2`**                  | **The compiler API is gone from the package main export.** `import('typescript')` yields only `{version, versionMajorMinor}`; `ts.createProgram` is not a function. The API moved to `typescript/unstable/sync` with a different shape |

The broken premise is not cost. It is availability: D2 assumed "the consumer
either has `typescript` or does not", and there is a third case — **the consumer
has `typescript` and it has no compiler API**, which is what
`npm install typescript@latest` now produces. A non-optional peer range of
`>=5.0.0` was verified to install exactly that version.

**Amended decision.** The primary shape source in v1 is the **explicit schema**
(approach C in this spec; `zod` is already a runtime dependency, ~0 ms, zero
version coupling). The compiler API becomes an **opt-in second source** behind a
guarded dynamic `import()`, version-gated on `ts.versionMajorMinor` to the
5.x-6.x classic API, abstaining with a named reason on 7.x and on absence. The
guard is already verified: an optional peer is not installed by npm, and the
failure is a clean `ERR_MODULE_NOT_FOUND`.

**Consequences for the sections below.** "Shape sources (v1)" now reads
schema-first, with the compiler-API row opt-in and version-gated. The
"Registrations required" line about a `typescript` dependency change becomes a
version **range that excludes 7.x**, not merely a change of dependency kind. The
D2 ADR should record the availability finding, not just the cost question.

**Not built on this evidence, per the spike:** a parse-only extractor as the
primary path (75% target-level abstention is a capability in name only),
anything using `noResolve`, an extractor against `typescript/unstable/*`, or
`typescript` as a non-optional peer or hard runtime dependency.

**Still unmeasured** (follow-ups if the compiler-API source is built): install
and bundle-size impact, a port to `typescript/unstable/sync`, the Python `ast`
path (A2, never checked), cost on a consumer repo rather than canary's own
`ts/src`, and warm long-lived-process cost such as an MCP server holding a
Program.

## Implementation order

1. **Spike (throwaway) — DONE 2026-09-15** (PR #986,
   spike/765-shape-extraction). Compiler API cost measured and affordable;
   availability is the blocker, so the ordering below is amended by 'D2
   revisited' above: the explicit schema comes first and the compiler API
   becomes an opt-in, version-gated second source. Python `ast` via `python3`
   (A2) remains unmeasured.
2. **ShapeNode + TS extractor + seeded generator, TDD.** Pure modules with
   fixture tests; abstention rules first (criteria 4-6).
3. **vitest emitter + `canary gen-data` CLI.** Exit codes, `--json`, self-check,
   the new-CLI-surface ratchets (criteria 1-3, 7, 9).
4. **Edge-case JSON output + case planner** (criterion 8).
5. **Python extractor + pytest emitter** (criterion 10 for pytest).
6. **ADRs for D2 and D7, docs, `canary-test-author` guidance.**
7. **Later, separate specs:** Playwright and k6 emitters, MCP tool, opt-in LLM
   placeholder strings.

Each numbered step 2-6 is one PR.

## Assumptions

- **A1:** The TypeScript compiler API can resolve imported interfaces within a
  project in well under 5 s for a single target. Checked by step 1.
- **A2:** Consumers of pytest output have `python3` on PATH at generation time;
  otherwise the Python path abstains (exit 3), it does not fall back.
- **A3:** Literal values in emitted code (rather than runtime generation) are
  acceptable file sizes for v1; a case cap of 50 per target is a starting value.
- **A4:** `tests/generated/fixtures/` is the right output root, following the
  existing `tests/generated/` convention.
- **A5:** The six-category model in `canary-edge-case-discovery` is stable
  enough to key strategies on.
- **A6:** The autonomous brainstorming run answered its own clarifying questions
  with recommended defaults; no human was consulted.

## Decisions for the human

| #   | Question                                                      | Options                                                                                                                                                                                             | Recommended default                                                                                                                                                                        |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Where does it live: skill, CLI subcommand, both — or harness? | (a) canary engine module + `canary gen-data` subcommand, skill/agent guidance later; (b) self-contained skill with `cli.mjs`; (c) both now; (d) harness concern                                     | **(a)**. It needs `ts/src/core` scanners, which is the canary line between skills and subcommands. harness has no test-authoring surface; `STRATEGY.md` "Test intelligence depth" owns it. |
| D2  | Shape source for TypeScript                                   | (a) TypeScript compiler API, `typescript` as optional peer dep, abstain if absent; (b) move `typescript` to hard runtime dep; (c) regex over type text (like `extractTsFunctions`); (d) schema-only | **(a)**. Consumer TS projects already have `typescript`; regex (c) cannot resolve imports and would guess; (b) bloats every install.                                                       |
| D3  | Edge-case coupling                                            | (a) additive `--format json` on edge-case-discovery, consumed optionally; (b) planner hardcodes strategies, no coupling; (c) parse the prose output                                                 | **(a)**. (c) is brittle; (b) ignores the issue's requirement.                                                                                                                              |
| D4  | Determinism mechanism                                         | (a) seeded generation at emit time, literal values in the file; (b) emit a seeded runtime generator call                                                                                            | **(a)**. Keeps PRNG and clocks out of the test entirely, so blackhawk/savant have nothing to flag.                                                                                         |
| D5  | v1 frameworks                                                 | (a) vitest + pytest; (b) vitest only; (c) all four                                                                                                                                                  | **(a)**, vitest first. Playwright and k6 data needs differ (page context, SharedArray) and get their own spec.                                                                             |
| D6  | Relationship to property-based testing                        | (a) canary emits example fixtures only; (b) also emit fast-check/Hypothesis arbitraries                                                                                                             | **(a)**. YAGNI; arbitraries are a different test style and add dependencies to consumer suites.                                                                                            |
| D7  | Model usage                                                   | (a) no model in the command at all in v1; (b) opt-in LLM string placeholders in v1; (c) LLM fills unresolved shapes                                                                                 | **(a)**. (c) is exactly the prototype #765 rejected and violates no-silent-abstention.                                                                                                     |
| D8  | Unresolved-field behavior on partial resolution               | (a) exit 0 with disclosed denominator and a failing placeholder; (b) exit 3 on any unresolved field                                                                                                 | **(a)**. A partial fixture with an honest denominator is more useful than silence, matching #486's F4 reasoning; zero resolved still exits 3.                                              |
